import type { UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useLayoutEffect, useRef } from "react";
import { AppError, answerOf } from "../../services/ipc";
import {
  claimTabBar,
  failTabBar,
  faultTabBar,
  firstTabBarFault,
  installTabBar,
  listened,
  moveTabBar,
  parseFault,
  parseGeometry,
  parsePick,
  setTabBar,
  tabBarStatus,
  useTabBarStatus,
  wantedTabBar,
  type TabBarState,
  type TabBarStatus,
  type TabPick,
} from "../../services/tabBar";
import { detailsOf, messageOf } from "../common/errorText";
import { toast } from "../common/Toast";

export const TABBAR_HEIGHT = "--tabbar-h";

export const INSTALL_FAILED = (m: string): string => `The tab bar could not be installed: ${m} The views stay at the bottom of the screen.`;

export const SET_FAILED = (m: string): string => `The tab bar stopped following the app: ${m} The views stay at the bottom of the screen.`;

export type TabBarMark = { height: number; mark: "bar" | "covered" } | null;

export function tabBarMark(status: TabBarStatus, planOpen: boolean, hidden: boolean): TabBarMark {
  if (status.k === "installed") return planOpen ? { height: status.height, mark: hidden ? "covered" : "bar" } : null;
  if (status.k === "failed" && status.height !== null) return { height: status.height, mark: "bar" };
  return null;
}

const route: { pick: ((p: TabPick) => void) | null } = { pick: null };

const asApp = (code: string, e: unknown): AppError => (e instanceof AppError ? e : new AppError(code, messageOf(e), e));

const shout = (e: AppError, text: string): void => toast(text, "bad", `${e.code}\n${detailsOf(e)}`);

function guarded(run: () => void): void {
  try {
    run();
  } catch (e) {
    const err = asApp("tabbar.event", e);
    shout(err, err.message);
  }
}

function onPicked(payload: unknown): void {
  guarded(() => {
    const pick = parsePick(payload);
    if (route.pick === null) throw new AppError("tabbar.unrouted", `The tab bar picked ${answerOf(pick)} while no view was there to take it.`);
    route.pick(pick);
  });
}

function onGeometry(payload: unknown): void {
  guarded(() => moveTabBar(parseGeometry(payload)));
}

function onFault(payload: unknown): void {
  guarded(() => {
    const fault = parseFault(payload);
    if (faultTabBar(fault) && firstTabBarFault()) shout(fault, SET_FAILED(fault.message));
  });
}

function installFailed(e: unknown): void {
  const err = asApp("tabbar.install", e);
  if (tabBarStatus().k !== "failed") failTabBar(err.message);
  if (firstTabBarFault()) shout(err, INSTALL_FAILED(err.message));
}

const fulfilled = (r: PromiseSettledResult<UnlistenFn>): r is PromiseFulfilledResult<UnlistenFn> => r.status === "fulfilled";

const rejected = (r: PromiseSettledResult<UnlistenFn>): r is PromiseRejectedResult => r.status === "rejected";

async function start(latest: { current: TabBarState }): Promise<void> {
  const subscribed = await Promise.allSettled([listened("tabbar-picked", onPicked), listened("tabbar-geometry", onGeometry), listened("tabbar-fault", onFault)]);
  const refused = subscribed.find(rejected);
  if (refused !== undefined) {
    subscribed.filter(fulfilled).forEach((r) => r.value());
    installFailed(refused.reason);
    return;
  }
  await installTabBar(latest.current).catch(installFailed);
}

const same = (a: TabBarState | null, b: TabBarState): boolean => a !== null && a.selected === b.selected && a.hidden === b.hidden && a.tint === b.tint;

export function useNativeTabBar(state: TabBarState, onPick: (p: TabPick) => void, planOpen: boolean): TabBarStatus {
  if (!planOpen && !state.hidden) throw new Error("The tab bar was asked to show with no plan open.");
  const status = useTabBarStatus();
  const pick = useRef(onPick);
  const latest = useRef(state);
  useLayoutEffect(() => {
    pick.current = onPick;
    latest.current = state;
  });

  useLayoutEffect(() => {
    const mine = (p: TabPick): void => pick.current(p);
    route.pick = mine;
    return () => {
      if (route.pick === mine) route.pick = null;
    };
  }, []);

  useEffect(() => {
    if (claimTabBar()) void start(latest);
  }, []);

  const { selected, hidden, tint } = state;
  const installed = status.k === "installed";

  useEffect(() => {
    if (!installed) return;
    const next: TabBarState = { selected, hidden, tint };
    if (same(wantedTabBar(), next)) return;
    setTabBar(next).catch((e: unknown) => {
      const err = asApp("tabbar.set", e);
      if (firstTabBarFault()) shout(err, SET_FAILED(err.message));
    });
  }, [installed, selected, hidden, tint]);

  const marked = tabBarMark(status, planOpen, hidden);
  const height = marked === null ? null : marked.height;
  const mark = marked === null ? null : marked.mark;

  useLayoutEffect(() => {
    if (height === null || mark === null) return;
    const html = document.documentElement;
    html.style.setProperty(TABBAR_HEIGHT, `${height}px`);
    html.dataset.tabbar = mark;
    return () => {
      html.style.removeProperty(TABBAR_HEIGHT);
      delete html.dataset.tabbar;
    };
  }, [height, mark]);

  return status;
}
