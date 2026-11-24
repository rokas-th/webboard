import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import { readPlatform } from "../platform";
import type { ViewKind } from "../ui/state";
import { messageOf } from "../ui/common/errorText";
import { PHONE_VIEWS } from "../ui/phone/views";
import { AppError, answerOf, call, callNull } from "./ipc";

export interface TabSpec {
  id: ViewKind;
  title: string;
  image: string;
}

export interface TabBarState {
  selected: ViewKind;
  hidden: boolean;
  tint: string;
}

export interface TabPick {
  id: ViewKind;
  again: boolean;
}

export type TabBarStatus =
  | { k: "off" }
  | { k: "installing" }
  | { k: "installed"; height: number }
  | { k: "failed"; reason: string; height: number | null };

export const TAB_IMAGES: Readonly<Record<ViewKind, string>> = {
  timeline: "calendar.day.timeline.left",
  board: "rectangle.split.3x1",
  list: "list.bullet",
};

export const phoneTabs = (): readonly TabSpec[] => PHONE_VIEWS.map(([id, title]) => ({ id, title, image: TAB_IMAGES[id] }));

export const usesNativeTabBar = (): boolean => {
  const p = readPlatform(window);
  return p.os === "ios" && p.idiom === "phone";
};

const record = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

const exactly = (x: unknown, keys: readonly string[]): x is Record<string, unknown> =>
  record(x) && Object.keys(x).length === keys.length && keys.every((k) => k in x);

const isViewKind = (x: unknown): x is ViewKind => PHONE_VIEWS.some(([id]) => id === x);

const filled = (x: unknown): x is string => typeof x === "string" && x.trim() !== "";

export function parseGeometry(x: unknown): number {
  if (exactly(x, ["height"]) && typeof x.height === "number" && Number.isFinite(x.height) && x.height > 0) return x.height;
  throw new AppError("ipc.shape", `The tab bar's geometry ${answerOf(x)} is not { height: a number above 0 }.`);
}

export function parsePick(x: unknown): TabPick {
  if (exactly(x, ["id", "again"]) && isViewKind(x.id) && typeof x.again === "boolean") return { id: x.id, again: x.again };
  throw new AppError("ipc.shape", `The tab bar's pick ${answerOf(x)} is not { id: timeline, board or list, again: a boolean }.`);
}

export function parseFault(x: unknown): AppError {
  if (exactly(x, ["code", "message"]) && filled(x.code) && filled(x.message)) return new AppError(x.code, x.message);
  throw new AppError("ipc.shape", `The tab bar's fault ${answerOf(x)} is not { code: a string, message: a string }.`);
}

export const listened = (name: string, handler: (payload: unknown) => void): Promise<UnlistenFn> =>
  listen<unknown>(name, (event) => handler(event.payload)).catch((e: unknown) => {
    throw new AppError("ipc.failed", `listen ${name}: ${messageOf(e)}.`, e);
  });

const listeners = new Set<() => void>();
let status: TabBarStatus = { k: "off" };
let asked = false;
let sent: TabBarState | null = null;
let wanted: TabBarState | null = null;
let told = false;
let pending: { height: number | null; fault: AppError | null } = { height: null, fault: null };

const put = (next: TabBarStatus): void => {
  status = next;
  [...listeners].forEach((cb) => cb());
};

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

export const tabBarStatus = (): TabBarStatus => status;

export const sentTabBar = (): TabBarState | null => sent;

export const wantedTabBar = (): TabBarState | null => wanted;

export function useTabBarStatus(): TabBarStatus {
  return useSyncExternalStore(subscribe, tabBarStatus);
}

export function resetTabBar(): void {
  asked = false;
  sent = null;
  wanted = null;
  told = false;
  pending = { height: null, fault: null };
  put({ k: "off" });
}

export function firstTabBarFault(): boolean {
  const first = !told;
  told = true;
  return first;
}

function onPhone(what: string): void {
  if (usesNativeTabBar()) return;
  const p = readPlatform(window);
  throw new AppError("tabbar.platform", `The tab bar was ${what} on ${p.idiom === null ? p.os : `the ${p.os} ${p.idiom}`}, where only the iPhone has one.`);
}

export function claimTabBar(): boolean {
  if (!usesNativeTabBar() || status.k !== "off") return false;
  put({ k: "installing" });
  return true;
}

const shownHeight = (): number | null => (status.k === "installed" || status.k === "failed" ? status.height : status.k === "installing" ? pending.height : null);

export function failTabBar(reason: string): void {
  put({ k: "failed", reason, height: shownHeight() });
}

export function moveTabBar(height: number): void {
  if (status.k === "off") throw new AppError("tabbar.unasked", `The tab bar reported a height of ${height} before it was asked to install.`);
  if (status.k === "installing") pending = { ...pending, height };
  else put({ ...status, height });
}

export function faultTabBar(fault: AppError): boolean {
  if (status.k === "off") throw new AppError("tabbar.unasked", `The tab bar reported ${fault.code} before it was asked to install: ${fault.message}`);
  if (status.k === "installing") {
    pending = { ...pending, fault: pending.fault ?? fault };
    return false;
  }
  if (status.k === "installed") failTabBar(fault.message);
  return true;
}

export async function installTabBar(state: TabBarState): Promise<number> {
  onPhone("asked to install");
  if (asked) throw new AppError("tabbar.twice", "The tab bar was asked to install twice in one page load.");
  asked = true;
  wanted = state;
  put({ k: "installing" });
  try {
    const answered = parseGeometry(await call<unknown>("tabbar_install", { bar: { tabs: phoneTabs(), state } }));
    const height = pending.height ?? answered;
    pending = { ...pending, height };
    if (pending.fault !== null) throw pending.fault;
    sent = state;
    put({ k: "installed", height });
    return height;
  } catch (e) {
    failTabBar(messageOf(e));
    throw e;
  }
}

export async function setTabBar(state: TabBarState): Promise<void> {
  onPhone("set");
  if (status.k !== "installed") throw new AppError("tabbar.not_installed", `The tab bar was set while it is ${status.k}, not installed.`);
  wanted = state;
  try {
    await callNull("tabbar_set", { state });
    sent = state;
  } catch (e) {
    failTabBar(messageOf(e));
    throw e;
  }
}
