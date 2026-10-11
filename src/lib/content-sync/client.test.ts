import { afterEach, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
import { fetch as nativeFetch } from "@tauri-apps/plugin-http";
import { useNetworkStore } from "../network";
import { contentServerRequest } from "./client";

afterEach(() => { useNetworkStore.setState({ connectivity: "online" }); vi.clearAllMocks(); });

it("reaches a configured LAN server even when public Internet connectivity is unavailable", async () => {
  useNetworkStore.setState({ connectivity: "offline" });
  vi.mocked(nativeFetch).mockResolvedValue(Response.json({ apiVersion: 1 }));
  await expect(contentServerRequest("http://127.0.0.1:7788", "/capabilities")).resolves.toEqual({ apiVersion: 1 });
});

it("serializes device registration as JSON and sends credentials only in the authorization header", async () => {
  vi.mocked(nativeFetch).mockResolvedValue(Response.json({ version: 1 }));
  await contentServerRequest("http://127.0.0.1:7788", "/devices/register", "private-token", "POST", { deviceName: "Tablet" });
  const [url, init] = vi.mocked(nativeFetch).mock.calls[0]!;
  expect(url).toBe("http://127.0.0.1:7788/api/v1/devices/register");
  expect(init?.body).toBe('{"deviceName":"Tablet"}');
  expect(init?.headers).toMatchObject({ Authorization: "Bearer private-token", "Content-Type": "application/json" });
});
