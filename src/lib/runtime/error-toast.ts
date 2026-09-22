import { notifications } from "@mantine/notifications";
import { describeError } from "../errors";

export function showErrorToast(title: string, error: unknown): void {
  notifications.show({
    color: "red",
    title,
    message: describeError(error),
    autoClose: 7_000,
  });
}
