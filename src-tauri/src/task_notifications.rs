use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum TaskNotificationGroupKey {
    Downloads,
    LibraryMetadata,
    LibraryUpdates,
    Search,
}

impl TaskNotificationGroupKey {
    fn as_str(self) -> &'static str {
        match self {
            Self::Downloads => "downloads",
            Self::LibraryMetadata => "libraryMetadata",
            Self::LibraryUpdates => "libraryUpdates",
            Self::Search => "search",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskNotificationProgress {
    current: f64,
    total: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskNotificationGroup {
    key: TaskNotificationGroupKey,
    title: String,
    body: String,
    paused: bool,
    progress: Option<TaskNotificationProgress>,
    pause_label: String,
    resume_label: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskNotificationChallenge {
    source_id: String,
    scope_key: String,
    revision: u64,
    title: String,
    body: String,
    action_label: String,
}

/// Where tapping a result opens; each target is a fixed `norea://` path.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum TaskNotificationCompletionAction {
    #[default]
    OpenTasks,
    OpenAttention,
    OpenUpdates,
    OpenNovel {
        novel_id: u64,
    },
    OpenChapter {
        novel_id: u64,
        chapter_id: u64,
    },
}

#[derive(Debug, Deserialize)]
struct TaskNotificationCompletion {
    key: TaskNotificationGroupKey,
    title: String,
    body: String,
    #[serde(default)]
    action: TaskNotificationCompletionAction,
}

#[derive(Debug, Deserialize)]
pub struct TaskNotificationPayload {
    groups: Vec<TaskNotificationGroup>,
    challenges: Vec<TaskNotificationChallenge>,
    completions: Vec<TaskNotificationCompletion>,
}

#[derive(Default)]
pub struct TaskNotificationState {
    #[cfg(target_os = "windows")]
    inner: std::sync::Mutex<windows_backend::WindowsNotificationState>,
}

#[cfg(any(target_os = "windows", test))]
mod model {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::collections::HashSet;

    pub(super) const GROUP_NOTIFICATION_GROUP: &str = "norea-tasks";
    pub(super) const SOURCE_NOTIFICATION_GROUP: &str = "norea-sources";
    pub(super) const COMPLETION_NOTIFICATION_GROUP: &str = "norea-results";

    #[derive(Clone, Debug, Eq, Hash, PartialEq)]
    pub(super) struct NotificationIdentity {
        pub(super) group: String,
        pub(super) tag: String,
    }

    #[derive(Clone, Debug, Eq, PartialEq, Serialize)]
    #[serde(
        tag = "type",
        rename_all = "camelCase",
        rename_all_fields = "camelCase"
    )]
    pub(super) enum TaskNotificationAction {
        OpenTasks,
        OpenAttention,
        OpenUpdates,
        OpenNovel {
            novel_id: u64,
        },
        OpenChapter {
            novel_id: u64,
            chapter_id: u64,
        },
        Pause {
            group_key: TaskNotificationGroupKey,
        },
        Resume {
            group_key: TaskNotificationGroupKey,
        },
        VerifySource {
            source_id: String,
            scope_key: String,
            revision: u64,
        },
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub(super) enum NotificationKind {
        Group,
        Source,
        Completion,
    }

    #[derive(Clone, Debug, Eq, PartialEq)]
    pub(super) struct NotificationProgress {
        pub(super) value: String,
        pub(super) count: String,
    }

    #[derive(Clone, Debug, Eq, PartialEq)]
    pub(super) struct NotificationCard {
        pub(super) identity: NotificationIdentity,
        pub(super) kind: NotificationKind,
        pub(super) title: String,
        pub(super) body: String,
        pub(super) progress: Option<NotificationProgress>,
        pub(super) body_action: TaskNotificationAction,
        pub(super) button: Option<(String, &'static str, TaskNotificationAction)>,
    }

    fn progress_value(progress: TaskNotificationProgress) -> Option<NotificationProgress> {
        let total = progress.total?;
        if !total.is_finite()
            || total <= 0.0
            || !progress.current.is_finite()
            || progress.current < 0.0
        {
            return None;
        }
        let current = progress.current.min(total);
        Some(NotificationProgress {
            value: (current / total).to_string(),
            count: format!("{current} / {total}"),
        })
    }

    pub(super) fn group_card(group: TaskNotificationGroup) -> NotificationCard {
        let (label, argument, action) = if group.paused {
            (
                group.resume_label,
                "resume",
                TaskNotificationAction::Resume {
                    group_key: group.key,
                },
            )
        } else {
            (
                group.pause_label,
                "pause",
                TaskNotificationAction::Pause {
                    group_key: group.key,
                },
            )
        };
        NotificationCard {
            identity: NotificationIdentity {
                group: GROUP_NOTIFICATION_GROUP.into(),
                tag: group.key.as_str().into(),
            },
            kind: NotificationKind::Group,
            title: group.title,
            body: group.body,
            progress: group.progress.and_then(progress_value),

            body_action: TaskNotificationAction::OpenTasks,
            button: Some((label, argument, action)),
        }
    }

    pub(super) fn challenge_card(challenge: TaskNotificationChallenge) -> NotificationCard {
        let digest = Sha256::digest(challenge.source_id.as_bytes());
        let tag = digest[..8]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let action = TaskNotificationAction::VerifySource {
            source_id: challenge.source_id,
            scope_key: challenge.scope_key,
            revision: challenge.revision,
        };
        NotificationCard {
            identity: NotificationIdentity {
                group: SOURCE_NOTIFICATION_GROUP.into(),
                tag,
            },
            kind: NotificationKind::Source,
            title: challenge.title,
            body: challenge.body,
            progress: None,

            body_action: action.clone(),
            button: Some((challenge.action_label, "verifySource", action)),
        }
    }

    const MAX_SAFE_ROW_ID: u64 = 9_007_199_254_740_991;

    fn completion_body_action(
        action: TaskNotificationCompletionAction,
    ) -> Result<TaskNotificationAction, String> {
        let valid = |id: u64| (1..=MAX_SAFE_ROW_ID).contains(&id);
        match action {
            TaskNotificationCompletionAction::OpenTasks => Ok(TaskNotificationAction::OpenTasks),
            TaskNotificationCompletionAction::OpenAttention => {
                Ok(TaskNotificationAction::OpenAttention)
            }
            TaskNotificationCompletionAction::OpenUpdates => {
                Ok(TaskNotificationAction::OpenUpdates)
            }
            TaskNotificationCompletionAction::OpenNovel { novel_id } if valid(novel_id) => {
                Ok(TaskNotificationAction::OpenNovel { novel_id })
            }
            TaskNotificationCompletionAction::OpenChapter {
                novel_id,
                chapter_id,
            } if valid(novel_id) && valid(chapter_id) => Ok(TaskNotificationAction::OpenChapter {
                novel_id,
                chapter_id,
            }),
            _ => Err("Task result notification has an invalid target".into()),
        }
    }

    pub(super) fn desired_cards(
        payload: TaskNotificationPayload,
    ) -> Result<Vec<NotificationCard>, String> {
        let mut cards: Vec<_> = payload.groups.into_iter().map(group_card).collect();
        for challenge in payload.challenges {
            if challenge.source_id.trim().is_empty()
                || challenge.scope_key.trim().is_empty()
                || challenge.revision == 0
                || challenge.revision > 9_007_199_254_740_991
            {
                return Err("Source verification notification has an invalid identity".into());
            }
            cards.push(challenge_card(challenge));
        }
        for result in payload.completions {
            cards.push(NotificationCard {
                identity: NotificationIdentity {
                    group: COMPLETION_NOTIFICATION_GROUP.into(),
                    tag: result.key.as_str().into(),
                },
                kind: NotificationKind::Completion,
                title: result.title,
                body: result.body,
                progress: None,

                body_action: completion_body_action(result.action)?,
                button: None,
            });
        }
        let mut identities = HashSet::new();
        if cards
            .iter()
            .any(|card| !identities.insert(card.identity.clone()))
        {
            return Err("Task notification payload contains duplicate identities".into());
        }
        Ok(cards)
    }

    fn xml_attribute(value: &str) -> String {
        value
            .chars()
            .filter(|character| {
                matches!(*character, '\t' | '\n' | '\r')
                    || (*character >= ' ' && !matches!(*character, '\u{fffe}' | '\u{ffff}'))
            })
            .fold(String::new(), |mut output, character| {
                match character {
                    '&' => output.push_str("&amp;"),
                    '<' => output.push_str("&lt;"),
                    '>' => output.push_str("&gt;"),
                    '\"' => output.push_str("&quot;"),
                    '\'' => output.push_str("&apos;"),
                    _ => output.push(character),
                }
                output
            })
    }

    pub(super) fn task_notification_protocol_url(
        action: &TaskNotificationAction,
    ) -> Option<String> {
        match action {
            TaskNotificationAction::OpenTasks => Some("norea://tasks".into()),
            TaskNotificationAction::OpenAttention => Some("norea://attention".into()),
            TaskNotificationAction::OpenUpdates => Some("norea://updates".into()),
            TaskNotificationAction::OpenNovel { novel_id } => {
                Some(format!("norea://novel/{novel_id}"))
            }
            TaskNotificationAction::OpenChapter {
                novel_id,
                chapter_id,
            } => Some(format!("norea://novel/{novel_id}/chapter/{chapter_id}")),
            TaskNotificationAction::VerifySource {
                source_id,
                scope_key,
                revision,
            } => {
                let mut url =
                    tauri::Url::parse("norea://tasks").expect("fixed task protocol URL is valid");
                url.query_pairs_mut()
                    .append_pair("action", "verifySource")
                    .append_pair("sourceId", source_id)
                    .append_pair("scopeKey", scope_key)
                    .append_pair("revision", &revision.to_string());
                Some(url.to_string())
            }
            TaskNotificationAction::Pause { .. } | TaskNotificationAction::Resume { .. } => None,
        }
    }

    pub(super) fn toast_xml(card: &NotificationCard) -> String {
        let launch = task_notification_protocol_url(&card.body_action)
            .expect("notification bodies open tasks or verify a source");
        let progress = if card.progress.is_some() {
            r#"<progress value="{progressValue}" valueStringOverride="{progressCount}" status=""/>"#
        } else {
            ""
        };
        let button = card.button.as_ref().map(|(label, argument, action)| {
            let protocol = task_notification_protocol_url(action);
            let activation_type = if protocol.is_some() { "protocol" } else { "foreground" };
            let arguments = protocol.as_deref().unwrap_or(argument);
            format!(r#"<actions><action content="{}" arguments="{}" activationType="{activation_type}"/></actions>"#,
                xml_attribute(label), xml_attribute(arguments))
        }).unwrap_or_default();
        let audio = if card.kind == NotificationKind::Group {
            r#"<audio silent="true"/>"#
        } else {
            ""
        };
        format!(
            r#"<toast activationType="protocol" launch="{}"><visual><binding template="ToastGeneric"><text>{{notificationTitle}}</text><text>{{notificationBody}}</text>{progress}</binding></visual>{button}{audio}</toast>"#,
            xml_attribute(&launch),
        )
    }

    pub(super) fn activation_action(
        card: &NotificationCard,
        argument: &str,
    ) -> Option<TaskNotificationAction> {
        card.button
            .as_ref()
            .filter(|(_, expected, action)| {
                argument == *expected
                    && matches!(
                        action,
                        TaskNotificationAction::Pause { .. }
                            | TaskNotificationAction::Resume { .. }
                    )
            })
            .map(|(_, _, action)| action.clone())
    }

    #[derive(Debug, Eq, PartialEq)]
    pub(super) enum NotificationUpdateKind {
        Unchanged,
        Data,
        Replace,
    }

    pub(super) fn notification_update_kind(
        previous: Option<&NotificationCard>,
        current: &NotificationCard,
    ) -> NotificationUpdateKind {
        let Some(previous) = previous else {
            return NotificationUpdateKind::Replace;
        };
        if current.kind == NotificationKind::Completion {
            return NotificationUpdateKind::Replace;
        }
        if previous == current {
            return NotificationUpdateKind::Unchanged;
        }
        if previous.body_action == current.body_action
            && previous.button == current.button
            && toast_xml(previous) == toast_xml(current)
        {
            NotificationUpdateKind::Data
        } else {
            NotificationUpdateKind::Replace
        }
    }

    pub(super) fn should_remove_notification(
        identity: &NotificationIdentity,
        current: &HashSet<NotificationIdentity>,
    ) -> bool {
        matches!(
            identity.group.as_str(),
            GROUP_NOTIFICATION_GROUP | SOURCE_NOTIFICATION_GROUP
        ) && !current.contains(identity)
    }
}

#[cfg(target_os = "windows")]
mod windows_backend {
    use super::{model::*, *};
    use std::collections::{HashMap, HashSet};
    use tauri::Emitter;
    use windows::{
        core::{IInspectable, Interface, HSTRING},
        Data::Xml::Dom::XmlDocument,
        Foundation::{Collections::StringMap, TypedEventHandler},
        UI::Notifications::{
            NotificationData, NotificationUpdateResult, ToastActivatedEventArgs, ToastNotification,
            ToastNotificationManager, ToastNotifier,
        },
    };

    #[derive(Default)]
    pub(super) struct WindowsNotificationState {
        active: HashMap<NotificationIdentity, ActiveToast>,
    }

    struct ActiveToast {
        card: NotificationCard,
        toast: ToastNotification,
        activation_token: Option<i64>,
    }

    impl Drop for ActiveToast {
        fn drop(&mut self) {
            if let Some(token) = self.activation_token {
                let _ = self.toast.RemoveActivated(token);
            }
        }
    }

    fn notification_app_id(app: &AppHandle) -> String {
        use std::path::MAIN_SEPARATOR as SEP;
        let identifier = app.config().identifier.clone();
        let Ok(exe) = tauri::utils::platform::current_exe() else {
            return identifier;
        };
        let Some(exe_dir) = exe.parent() else {
            return identifier;
        };
        let current_dir = exe_dir.display().to_string();
        if current_dir.ends_with(format!("{SEP}target{SEP}debug").as_str())
            || current_dir.ends_with(format!("{SEP}target{SEP}release").as_str())
        {
            tauri_winrt_notification::Toast::POWERSHELL_APP_ID.to_string()
        } else {
            identifier
        }
    }

    fn notification_data(card: &NotificationCard) -> windows::core::Result<NotificationData> {
        let values = StringMap::new()?;
        values.Insert(
            &HSTRING::from("notificationTitle"),
            &HSTRING::from(&card.title),
        )?;
        values.Insert(
            &HSTRING::from("notificationBody"),
            &HSTRING::from(&card.body),
        )?;
        if let Some(progress) = &card.progress {
            values.Insert(
                &HSTRING::from("progressValue"),
                &HSTRING::from(&progress.value),
            )?;
            values.Insert(
                &HSTRING::from("progressCount"),
                &HSTRING::from(&progress.count),
            )?;
        }
        NotificationData::CreateNotificationDataWithValuesAndSequenceNumber(&values, 0)
    }

    fn show_card(
        app: &AppHandle,
        notifier: &ToastNotifier,
        card: NotificationCard,
        replacing: bool,
    ) -> windows::core::Result<ActiveToast> {
        let document = XmlDocument::new()?;
        document.LoadXml(&HSTRING::from(toast_xml(&card)))?;
        let toast = ToastNotification::CreateToastNotification(&document)?;
        toast.SetTag(&HSTRING::from(&card.identity.tag))?;
        toast.SetGroup(&HSTRING::from(&card.identity.group))?;
        toast.SetSuppressPopup(
            card.kind == NotificationKind::Group
                || (replacing && card.kind != NotificationKind::Completion),
        )?;
        toast.SetData(&notification_data(&card)?)?;
        let activation_token = if card.kind == NotificationKind::Group {
            let callback_app = app.clone();
            let callback_card = card.clone();
            let handler =
                TypedEventHandler::<ToastNotification, IInspectable>::new(move |_, arguments| {
                    let argument = arguments
                        .as_ref()
                        .and_then(|value| value.cast::<ToastActivatedEventArgs>().ok())
                        .and_then(|value| value.Arguments().ok())
                        .map(|value| value.to_string())
                        .unwrap_or_default();
                    let Some(action) = activation_action(&callback_card, &argument) else {
                        return Ok(());
                    };
                    if let Err(error) = callback_app.emit("task-notification-action", action) {
                        log::warn!("Deliver task notification action: {error}");
                    }
                    Ok(())
                });
            Some(toast.Activated(&handler)?)
        } else {
            None
        };
        let active = ActiveToast {
            card,
            toast,
            activation_token,
        };
        notifier.Show(&active.toast)?;
        Ok(active)
    }

    pub(super) fn reconcile(
        app: &AppHandle,
        payload: TaskNotificationPayload,
        state: &TaskNotificationState,
    ) -> Result<(), String> {
        let cards = desired_cards(payload)?;
        let current: HashSet<_> = cards.iter().map(|card| card.identity.clone()).collect();
        let app_id = HSTRING::from(notification_app_id(app));
        let mut state = state
            .inner
            .lock()
            .map_err(|_| "Task notification state is unavailable".to_string())?;
        let notifier = ToastNotificationManager::CreateToastNotifierWithId(&app_id)
            .map_err(|error| format!("Create task notifier: {error}"))?;
        let history = ToastNotificationManager::History()
            .map_err(|error| format!("Read task notification history: {error}"))?;
        let visible = history
            .GetHistoryWithId(&app_id)
            .map_err(|error| format!("Read app task notifications: {error}"))?;
        for toast in visible {
            let identity = NotificationIdentity {
                group: toast
                    .Group()
                    .map_err(|error| format!("Read task notification group: {error}"))?
                    .to_string(),
                tag: toast
                    .Tag()
                    .map_err(|error| format!("Read task notification tag: {error}"))?
                    .to_string(),
            };
            if should_remove_notification(&identity, &current) {
                history
                    .RemoveGroupedTagWithId(
                        &HSTRING::from(&identity.tag),
                        &HSTRING::from(&identity.group),
                        &app_id,
                    )
                    .map_err(|error| format!("Remove resolved task notification: {error}"))?;
            }
        }
        state
            .active
            .retain(|identity, _| !should_remove_notification(identity, &current));
        for card in cards {
            let previous = state.active.get(&card.identity);
            match notification_update_kind(previous.map(|active| &active.card), &card) {
                NotificationUpdateKind::Unchanged => continue,
                NotificationUpdateKind::Data => {
                    let data = notification_data(&card)
                        .map_err(|error| format!("Create task notification data: {error}"))?;
                    let result = notifier
                        .UpdateWithTagAndGroup(
                            &data,
                            &HSTRING::from(&card.identity.tag),
                            &HSTRING::from(&card.identity.group),
                        )
                        .map_err(|error| format!("Update task notification: {error}"))?;
                    if result == NotificationUpdateResult::Succeeded {
                        if let Some(active) = state.active.get_mut(&card.identity) {
                            active.card = card;
                        }
                        continue;
                    }
                }
                NotificationUpdateKind::Replace => {}
            }
            let replacing = state.active.contains_key(&card.identity);
            let active = show_card(app, &notifier, card, replacing)
                .map_err(|error| format!("Show task notification: {error}"))?;
            state.active.insert(active.card.identity.clone(), active);
        }
        Ok(())
    }
}

#[tauri::command]
pub fn task_notification_reconcile(
    app: AppHandle,
    payload: TaskNotificationPayload,
    state: State<'_, TaskNotificationState>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        windows_backend::reconcile(&app, payload, &state)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, payload, state);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::model::*;
    use super::*;

    fn group(paused: bool, current: f64, total: Option<f64>) -> NotificationCard {
        group_card(TaskNotificationGroup {
            key: TaskNotificationGroupKey::Downloads,
            title: "Downloads".into(),
            body: "Chapter 3".into(),
            paused,
            progress: Some(TaskNotificationProgress { current, total }),
            pause_label: "Pause & inspect <queue>".into(),
            resume_label: "Resume".into(),
        })
    }

    fn challenge(revision: u64) -> NotificationCard {
        challenge_card(TaskNotificationChallenge {
            source_id: "source-a".into(),
            scope_key: "novel:42".into(),
            revision,
            title: "Verify source".into(),
            body: "Continue in the source browser".into(),
            action_label: "Verify".into(),
        })
    }

    #[test]
    fn xml_escapes_action_labels_and_uses_only_fixed_activation_arguments() {
        let xml = toast_xml(&group(false, 3.0, Some(12.0)));
        assert!(xml.contains("content=\"Pause &amp; inspect &lt;queue&gt;\""));
        assert!(xml.contains("activationType=\"protocol\" launch=\"norea://tasks\""));
        assert!(xml.contains("arguments=\"pause\""));
        let source_xml = toast_xml(&challenge(7));
        assert_eq!(source_xml.matches("activationType=\"protocol\"").count(), 2);
        assert!(source_xml.contains(
            "action=verifySource&amp;sourceId=source-a&amp;scopeKey=novel%3A42&amp;revision=7"
        ));
        assert!(!source_xml.contains("activationType=\"foreground\""));
    }

    #[test]
    fn protocol_source_actions_encode_fields_without_accepting_an_arbitrary_target() {
        let action = TaskNotificationAction::VerifySource {
            source_id: "source & one".into(),
            scope_key: "plugin:source:site:https://source.test/?a=1&b=two words".into(),
            revision: 7,
        };
        let raw = task_notification_protocol_url(&action).unwrap();
        let url = tauri::Url::parse(&raw).unwrap();
        assert_eq!(url.scheme(), "norea");
        assert_eq!(url.host_str(), Some("tasks"));
        let fields: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(fields.len(), 4);
        assert_eq!(fields["action"], "verifySource");
        assert_eq!(fields["sourceId"], "source & one");
        assert_eq!(
            fields["scopeKey"],
            "plugin:source:site:https://source.test/?a=1&b=two words"
        );
        assert_eq!(fields["revision"], "7");
        assert_eq!(
            task_notification_protocol_url(&TaskNotificationAction::OpenTasks),
            Some("norea://tasks".into())
        );
        assert_eq!(
            task_notification_protocol_url(&TaskNotificationAction::Pause {
                group_key: TaskNotificationGroupKey::Downloads
            }),
            None
        );
    }

    #[test]
    fn progress_uses_real_counts_and_omits_a_bar_when_the_total_is_unknown() {
        assert!(!toast_xml(&group(false, 0.0, None)).contains("<progress"));
        let card = group(false, 15.0, Some(12.0));
        let progress = card.progress.unwrap();
        assert_eq!(progress.value, "1");
        assert_eq!(progress.count, "12 / 12");
        assert!(group(false, f64::NAN, Some(12.0)).progress.is_none());
    }

    #[test]
    fn source_identity_is_stable_and_separate_from_group_and_completion_cards() {
        let source = challenge(7).identity;
        assert_eq!(source.tag, "0f9f5ce47831e099");
        assert_eq!(source.group, SOURCE_NOTIFICATION_GROUP);
        assert_ne!(source, group(false, 1.0, Some(2.0)).identity);
        assert_ne!(
            source,
            challenge_card(TaskNotificationChallenge {
                source_id: "source-b".into(),
                scope_key: "novel:42".into(),
                revision: 7,
                title: String::new(),
                body: String::new(),
                action_label: String::new(),
            })
            .identity
        );
    }

    #[test]
    fn body_and_controls_resolve_only_the_actions_owned_by_that_card() {
        assert_eq!(
            activation_action(&group(false, 1.0, Some(2.0)), "pause"),
            Some(TaskNotificationAction::Pause {
                group_key: TaskNotificationGroupKey::Downloads
            }),
        );
        assert_eq!(
            activation_action(&group(true, 1.0, Some(2.0)), "pause"),
            None
        );
        assert_eq!(activation_action(&challenge(7), "verifySource"), None);
        assert_eq!(
            activation_action(&group(false, 1.0, Some(2.0)), "openTasks"),
            None
        );
        assert_eq!(activation_action(&challenge(7), ""), None);
        assert_eq!(activation_action(&challenge(7), "pause"), None);
        assert_eq!(
            activation_action(&challenge(7), "https://untrusted.example/"),
            None
        );
    }

    #[test]
    fn ordinary_progress_changes_update_data_but_controls_and_revisions_replace_callbacks() {
        let previous = group(false, 1.0, Some(12.0));
        assert_eq!(
            notification_update_kind(Some(&previous), &group(false, 2.0, Some(12.0))),
            NotificationUpdateKind::Data
        );
        assert_eq!(
            notification_update_kind(Some(&previous), &group(true, 2.0, Some(12.0))),
            NotificationUpdateKind::Replace
        );
        assert_eq!(
            notification_update_kind(Some(&challenge(7)), &challenge(8)),
            NotificationUpdateKind::Replace
        );
        assert_eq!(
            notification_update_kind(Some(&previous), &previous),
            NotificationUpdateKind::Unchanged
        );
    }

    #[test]
    fn reconciliation_removes_absent_groups_and_sources_but_retains_results() {
        let active = group(false, 1.0, Some(2.0)).identity;
        let source = challenge(1).identity;
        let result = NotificationIdentity {
            group: COMPLETION_NOTIFICATION_GROUP.into(),
            tag: "downloads".into(),
        };
        let unrelated = NotificationIdentity {
            group: "other-feature".into(),
            tag: "keep".into(),
        };
        let current = std::collections::HashSet::new();
        assert!(should_remove_notification(&active, &current));
        assert!(should_remove_notification(&source, &current));
        assert!(!should_remove_notification(&result, &current));
        assert!(!should_remove_notification(&unrelated, &current));
    }

    #[test]
    fn completion_events_replace_the_previous_result_even_when_the_counts_match() {
        let payload: TaskNotificationPayload = serde_json::from_value(serde_json::json!({
            "groups": [], "challenges": [],
            "completions": [{"key":"downloads", "title":"Completed", "body":"2 chapters"}]
        }))
        .unwrap();
        let card = desired_cards(payload).unwrap().pop().unwrap();
        assert_eq!(
            notification_update_kind(Some(&card), &card),
            NotificationUpdateKind::Replace
        );
    }

    fn completion_card(action: serde_json::Value) -> Result<NotificationCard, String> {
        let payload: TaskNotificationPayload = serde_json::from_value(serde_json::json!({
            "groups": [], "challenges": [],
            "completions": [{"key":"downloads", "title":"Completed", "body":"2 chapters", "action": action}]
        }))
        .map_err(|error| error.to_string())?;
        desired_cards(payload).map(|mut cards| cards.pop().unwrap())
    }

    #[test]
    fn result_targets_open_fixed_protocol_paths() {
        for (action, launch) in [
            (serde_json::json!({"type":"openTasks"}), "norea://tasks"),
            (serde_json::json!({"type":"openAttention"}), "norea://attention"),
            (serde_json::json!({"type":"openUpdates"}), "norea://updates"),
            (
                serde_json::json!({"type":"openNovel", "novelId": 3, "url": "https://untrusted.example/"}),
                "norea://novel/3",
            ),
            (
                serde_json::json!({"type":"openChapter", "novelId": 3, "chapterId": 9}),
                "norea://novel/3/chapter/9",
            ),
        ] {
            let xml = toast_xml(&completion_card(action).unwrap());
            assert!(xml.contains(&format!("activationType=\"protocol\" launch=\"{launch}\"")));
        }
    }

    #[test]
    fn result_targets_reject_unknown_types_and_out_of_range_ids() {
        for action in [
            serde_json::json!({"type":"verifySource", "sourceId":"a", "scopeKey":"b", "revision":1}),
            serde_json::json!({"type":"openNovel", "novelId": 0}),
            serde_json::json!({"type":"openNovel", "novelId": -1}),
            serde_json::json!({"type":"openNovel", "novelId": 9_007_199_254_740_992_u64}),
            serde_json::json!({"type":"openChapter", "novelId": 3}),
            serde_json::json!({"type":"openChapter", "novelId": 3, "chapterId": 0}),
        ] {
            assert!(completion_card(action).is_err());
        }
    }

    #[test]
    fn source_action_serialization_matches_the_frontend_event_contract() {
        let action = challenge(7).body_action;
        assert_eq!(
            serde_json::to_value(action).unwrap(),
            serde_json::json!({
                "type":"verifySource", "sourceId":"source-a", "scopeKey":"novel:42", "revision":7
            })
        );
    }

    #[test]
    fn payload_rejects_unknown_group_actions_and_negative_source_revisions() {
        let invalid_group = serde_json::json!({"groups":[{"key":"arbitrary","title":"x","body":"x","paused":false,"pauseLabel":"x","resumeLabel":"x"}],"challenges":[],"completions":[]});
        assert!(serde_json::from_value::<TaskNotificationPayload>(invalid_group).is_err());
        let invalid_source = serde_json::json!({"groups":[],"challenges":[{"sourceId":"source-a","scopeKey":"scope","revision":-1,"title":"x","body":"x","actionLabel":"x"}],"completions":[]});
        assert!(serde_json::from_value::<TaskNotificationPayload>(invalid_source).is_err());
    }
}
