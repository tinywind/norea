import type { SourceAccessBlock, TaskEvent, TaskSnapshot } from "./scheduler";
import type { TaskNotificationTranslate } from "./task-notification-model";

export interface SourceAccessNotification {
  sourceId: string;
  scopeKey: string;
  revision: number;
  title: string;
  body: string;
  actionLabel: string;
}

export class SourceAccessNotificationTracker {
  private readonly names = new Map<string, string>();

  constructor(snapshot: Pick<TaskSnapshot, "records">) {
    for (const task of snapshot.records) this.update({ task });
  }

  update({ task }: Pick<TaskEvent, "task">): boolean {
    if (!task.source || this.names.get(task.source.id) === task.source.name) return false;
    this.names.set(task.source.id, task.source.name);
    return true;
  }

  revision(blocks: readonly SourceAccessBlock[]): string {
    return JSON.stringify(blocks.filter(block => block.rangeId === undefined)
      .map(block => [block.sourceId, block.scopeKey, block.revision, this.names.get(block.sourceId)]));
  }

  notifications(blocks: readonly SourceAccessBlock[], t: TaskNotificationTranslate): SourceAccessNotification[] {
    const groups = new Map<string, SourceAccessBlock[]>();
    for (const block of blocks) {
      if (block.rangeId !== undefined) continue;
      const group = groups.get(block.sourceId);
      if (group) group.push(block);
      else groups.set(block.sourceId, [block]);
    }
    return [...groups].map(([sourceId, blocks]) => {
      const forbidden = blocks.find(block => block.challenge.kind === "forbidden");
      const block = forbidden ?? blocks[0]!;
      const source = this.names.get(sourceId) ?? sourceId;
      return {
        sourceId, scopeKey: block.scopeKey, revision: block.revision,
        title: forbidden ? t("sourceAccess.forbiddenTitle") : t("sourceAccess.notificationTitleForSource", { source }),
        body: forbidden ? t("errors.forbidden") : blocks.length > 1
          ? t("sourceAccess.notificationMore", { source, count: blocks.length })
          : t("sourceAccess.notificationMessage", { source }),
        actionLabel: t("sourceAccess.notificationAction"),
      };
    });
  }
}
