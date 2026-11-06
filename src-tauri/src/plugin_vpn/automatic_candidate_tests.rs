use std::{collections::HashMap, sync::Mutex};

use tokio::sync::watch;

type CleanupResult = Option<Result<(), String>>;

struct CandidateRun {
    cancellation: watch::Sender<bool>,
    completion: watch::Receiver<CleanupResult>,
    completion_sender: Option<watch::Sender<CleanupResult>>,
}

#[derive(Default)]
pub(super) struct AutomaticCandidateTests {
    runs: Mutex<HashMap<String, CandidateRun>>,
}

pub(super) struct AutomaticCandidateTest<'a> {
    tests: &'a AutomaticCandidateTests,
    id: String,
    cancellation: watch::Receiver<bool>,
    completion: Option<watch::Sender<CleanupResult>>,
}

impl AutomaticCandidateTests {
    pub(super) fn prepare(&self, id: &str) -> Result<(), String> {
        if id.is_empty() || id.len() > 64 || !id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-') {
            return Err("automatic VPN candidate test ID is invalid".to_string());
        }
        let mut runs = self.runs.lock().expect("automatic VPN candidate tests lock");
        if runs.contains_key(id) { return Err("automatic VPN candidate test ID is already registered".to_string()); }
        let (cancellation, _) = watch::channel(false);
        let (completion_sender, completion) = watch::channel(None);
        runs.insert(id.to_string(), CandidateRun { cancellation, completion, completion_sender: Some(completion_sender) });
        Ok(())
    }

    pub(super) fn start(&self, id: &str) -> Result<AutomaticCandidateTest<'_>, String> {
        let mut runs = self.runs.lock().expect("automatic VPN candidate tests lock");
        let run = runs.get_mut(id).ok_or_else(|| "automatic VPN candidate test is not registered".to_string())?;
        let completion = run.completion_sender.take().ok_or_else(|| "automatic VPN candidate test is already running".to_string())?;
        Ok(AutomaticCandidateTest { tests: self, id: id.to_string(), cancellation: run.cancellation.subscribe(), completion: Some(completion) })
    }

    pub(super) async fn cancel(&self, id: &str) -> Result<(), String> {
        let mut completion = {
            let mut runs = self.runs.lock().expect("automatic VPN candidate tests lock");
            let Some(run) = runs.get(id) else { return Ok(()); };
            if run.completion_sender.is_some() {
                runs.remove(id);
                return Ok(());
            }
            run.cancellation.send_replace(true);
            run.completion.clone()
        };
        loop {
            if let Some(result) = completion.borrow_and_update().clone() { return result; }
            completion.changed().await.map_err(|_| "automatic VPN candidate test cleanup monitor closed".to_string())?;
        }
    }
}

impl AutomaticCandidateTest<'_> {
    pub(super) fn cancellation(&self) -> watch::Receiver<bool> { self.cancellation.clone() }

    pub(super) fn is_cancelled(&self) -> bool { *self.cancellation.borrow() }

    pub(super) fn publish<T>(&self, publish: impl FnOnce() -> Result<T, String>) -> Result<Option<T>, String> {
        let _runs = self.tests.runs.lock().expect("automatic VPN candidate tests lock");
        if self.is_cancelled() { return Ok(None); }
        publish().map(Some)
    }

    pub(super) fn finish(mut self, result: Result<bool, String>) -> Result<bool, String> {
        let mut runs = self.tests.runs.lock().expect("automatic VPN candidate tests lock");
        let cancelled = self.is_cancelled();
        runs.remove(&self.id);
        self.completion.take().expect("automatic VPN candidate test completion").send_replace(Some(Ok(())));
        if cancelled { Ok(false) } else { result }
    }
}

impl Drop for AutomaticCandidateTest<'_> {
    fn drop(&mut self) {
        if let Some(completion) = self.completion.take() {
            let runs = self.tests.runs.lock().expect("automatic VPN candidate tests lock");
            if let Some(run) = runs.get(&self.id) { run.cancellation.send_replace(true); }
            completion.send_replace(Some(Err("automatic VPN candidate test cleanup was not confirmed".to_string())));
        }
    }
}

#[cfg(any(target_os = "android", test))]
pub(super) async fn wait_for_cancellation(cancellation: &mut watch::Receiver<bool>) {
    loop {
        if *cancellation.borrow_and_update() { return; }
        if cancellation.changed().await.is_err() { return; }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancellation_waits_for_an_active_probe_to_finish_cleanup() {
        let tests = AutomaticCandidateTests::default();
        tests.prepare("probe-1").unwrap();
        let probe = tests.start("probe-1").unwrap();
        let mut cancellation = Box::pin(tests.cancel("probe-1"));

        assert!(tokio::time::timeout(std::time::Duration::from_millis(10), &mut cancellation).await.is_err());
        assert!(probe.is_cancelled());
        assert_eq!(probe.publish(|| panic!("a cancelled probe published a successful test")), Ok::<Option<()>, String>(None));
        assert!(!probe.finish(Ok(true)).unwrap());
        assert_eq!(cancellation.await, Ok(()));
    }

    #[tokio::test]
    async fn cancellation_before_start_prevents_a_late_tunnel_from_starting() {
        let tests = AutomaticCandidateTests::default();
        tests.prepare("probe-1").unwrap();
        tests.cancel("probe-1").await.unwrap();

        assert!(tests.start("probe-1").is_err());
        tests.prepare("probe-2").unwrap();
        assert!(tests.start("probe-2").unwrap().finish(Ok(true)).unwrap());
    }

    #[tokio::test]
    async fn cancellation_is_scoped_to_the_named_probe() {
        let tests = AutomaticCandidateTests::default();
        tests.prepare("probe-1").unwrap();
        tests.prepare("probe-2").unwrap();
        let first = tests.start("probe-1").unwrap();
        let second = tests.start("probe-2").unwrap();
        let mut cancellation = Box::pin(tests.cancel("probe-1"));

        assert!(tokio::time::timeout(std::time::Duration::from_millis(10), &mut cancellation).await.is_err());
        assert!(!second.is_cancelled());
        assert!(second.finish(Ok(true)).unwrap());
        assert!(!first.finish(Ok(true)).unwrap());
        cancellation.await.unwrap();
    }

    #[tokio::test]
    async fn an_abandoned_probe_reports_unconfirmed_cleanup_to_its_canceller() {
        let tests = AutomaticCandidateTests::default();
        tests.prepare("probe-1").unwrap();
        let probe = tests.start("probe-1").unwrap();
        let mut cancellation = Box::pin(tests.cancel("probe-1"));

        assert!(tokio::time::timeout(std::time::Duration::from_millis(10), &mut cancellation).await.is_err());
        drop(probe);
        assert!(cancellation.await.unwrap_err().contains("cleanup was not confirmed"));
        assert!(tests.cancel("probe-1").await.unwrap_err().contains("cleanup was not confirmed"));
    }
}
