// Copyright 2020-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::{
  collections::HashMap,
  sync::{Mutex, OnceLock},
};

use crate::util::Counter;

pub(crate) type EvalCallback = Box<dyn Fn(String) + Send + 'static>;

pub(crate) const NO_EVAL_CALLBACK_ID: i32 = -1;

static EVAL_ID_GENERATOR: Counter = Counter::new();
static EVAL_CALLBACKS: OnceLock<Mutex<HashMap<i32, EvalCallback>>> = OnceLock::new();

#[inline]
pub(crate) fn should_register_eval_callback(has_callback: bool) -> bool {
  has_callback || cfg!(feature = "tracing")
}

#[inline]
pub(crate) fn next_eval_id() -> i32 {
  next_non_negative_eval_id(EVAL_ID_GENERATOR.next())
}

#[inline]
fn next_non_negative_eval_id(raw: u32) -> i32 {
  (raw & (i32::MAX as u32)) as i32
}

pub(crate) fn register_eval_callback(id: i32, callback: EvalCallback) {
  let replaced = EVAL_CALLBACKS
    .get_or_init(Default::default)
    .lock()
    .unwrap()
    .insert(id, callback);
  drop(replaced);
}

pub(crate) fn take_eval_callback(id: i32) -> Option<EvalCallback> {
  if id < 0 {
    return None;
  }
  EVAL_CALLBACKS
    .get_or_init(Default::default)
    .lock()
    .unwrap()
    .remove(&id)
}

#[cfg(test)]
mod tests {
  use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
  };

  use super::*;

  #[test]
  fn fire_and_forget_eval_skips_callback_registration_without_tracing() {
    assert_eq!(should_register_eval_callback(false), cfg!(feature = "tracing"));
    assert!(should_register_eval_callback(true));
    assert!(take_eval_callback(NO_EVAL_CALLBACK_ID).is_none());
  }

  #[test]
  fn eval_ids_stay_non_negative_across_u32_wraparound() {
    for raw in [0, 1, i32::MAX as u32, (i32::MAX as u32) + 1, u32::MAX] {
      assert!(next_non_negative_eval_id(raw) >= 0, "raw={raw}");
    }
  }

  #[test]
  fn take_eval_callback_removes_entry_and_releases_lock_for_reentrant_registration() {
    let outer_id = next_eval_id();
    let inner_id = next_eval_id();
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_outer = calls.clone();
    let guard = Arc::new(());
    let weak_guard = Arc::downgrade(&guard);

    register_eval_callback(
      outer_id,
      Box::new(move |result| {
        let _keep = &guard;
        assert_eq!(result, "\"outer\"");
        calls_outer.fetch_add(1, Ordering::SeqCst);
        let calls_inner = calls_outer.clone();
        // Re-entrantly registering another eval callback inside `onEval` must not deadlock.
        register_eval_callback(
          inner_id,
          Box::new(move |inner_result| {
            assert_eq!(inner_result, "\"inner\"");
            calls_inner.fetch_add(1, Ordering::SeqCst);
          }),
        );
      }),
    );

    let cb = take_eval_callback(outer_id).expect("registered outer callback");
    assert!(take_eval_callback(outer_id).is_none(), "callback must be removed once");
    cb("\"outer\"".to_string());
    drop(cb);
    assert_eq!(weak_guard.strong_count(), 0, "outer closure captures must drop after completion");

    let inner_cb = take_eval_callback(inner_id).expect("registered inner callback");
    assert!(take_eval_callback(inner_id).is_none());
    inner_cb("\"inner\"".to_string());
    assert_eq!(calls.load(Ordering::SeqCst), 2);
  }
}
