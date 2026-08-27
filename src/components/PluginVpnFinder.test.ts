import { describe, expect, it } from "vitest";
import { translate } from "../i18n";
import type { PluginVpnFinderServer } from "../lib/plugin-vpn";
import { filterAndSortPluginVpnServers } from "./PluginVpnFinder";

const SERVERS: PluginVpnFinderServer[] = [
  {
    activeSessions: 8,
    candidateId: "jp-fast",
    countryCode: "JP",
    countryName: "Japan",
    hostName: "public-vpn-jp",
    ip: "203.0.113.10",
    logType: "2weeks",
    pingMs: 30,
    protocol: "tcp",
    score: 900,
    speedBps: 120_000_000,
    totalUsers: 100,
    uptimeMs: 3_600_000,
  },
  {
    activeSessions: 3,
    candidateId: "kr-low-ping",
    countryCode: "KR",
    countryName: "Korea Republic of",
    hostName: "public-vpn-kr",
    ip: "198.51.100.20",
    logType: "2weeks",
    pingMs: 12,
    protocol: "udp",
    score: 700,
    speedBps: 80_000_000,
    totalUsers: 50,
    uptimeMs: 7_200_000,
  },
  {
    activeSessions: 1,
    candidateId: "jp-no-ping",
    countryCode: "JP",
    countryName: "Japan",
    hostName: "public-vpn-jp-2",
    ip: "192.0.2.30",
    logType: "2weeks",
    pingMs: null,
    protocol: "udp",
    score: 600,
    speedBps: 40_000_000,
    totalUsers: 20,
    uptimeMs: 1_800_000,
  },
];

describe("PluginVpnFinder", () => {
  it("filters by country, protocol, and normalized country or IP search", () => {
    expect(
      filterAndSortPluginVpnServers(SERVERS, {
        countryCode: "JP",
        protocol: "udp",
        search: "192.0.2",
        sort: "score",
      }).map((server) => server.candidateId),
    ).toEqual(["jp-no-ping"]);

    expect(
      filterAndSortPluginVpnServers(SERVERS, {
        countryCode: "",
        protocol: "",
        search: "korea",
        sort: "score",
      }).map((server) => server.candidateId),
    ).toEqual(["kr-low-ping"]);
  });

  it("sorts missing ping measurements after measured servers", () => {
    expect(
      filterAndSortPluginVpnServers(SERVERS, {
        countryCode: "",
        protocol: "",
        search: "",
        sort: "ping",
      }).map((server) => server.candidateId),
    ).toEqual(["kr-low-ping", "jp-fast", "jp-no-ping"]);
  });

  it("formats localized ping and speed units without leftover braces", () => {
    expect(
      translate("en", "settings.data.pluginVpn.finder.value.ping", {
        value: "24",
      }),
    ).toBe("24 ms");
    expect(
      translate("ko", "settings.data.pluginVpn.finder.value.speed", {
        value: "125.4",
      }),
    ).toBe("125.4Mbps");
  });
});
