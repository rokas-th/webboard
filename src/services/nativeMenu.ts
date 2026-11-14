import { listen } from "@tauri-apps/api/event";
import { newId } from "../log/ids";
import { readPlatform } from "../platform";
import { detailsOf } from "../ui/common/errorText";
import { toast } from "../ui/common/Toast";
import { AppError, answerOf, callNull } from "./ipc";

export interface NativeMenuRow {
  id: string;
  title: string;
  checked: boolean;
}

export interface NativeMenuSection {
  title: string | null;
  rows: readonly NativeMenuRow[];
}

export interface NativeMenuAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeMenuHandlers {
  chosen(id: string): void;
  ended(): void;
}

interface Route {
  on: NativeMenuHandlers;
  chosen: boolean;
  ended: boolean;
}

export const usesNativeMenu = (): boolean => readPlatform(window).os === "ios";

export function anchorOf(box: { left: number; top: number; width: number; height: number }, view: { offsetLeft: number; offsetTop: number; scale: number }): NativeMenuAnchor {
  return {
    x: (box.left - view.offsetLeft) * view.scale,
    y: (box.top - view.offsetTop) * view.scale,
    width: box.width * view.scale,
    height: box.height * view.scale,
  };
}

const routes = new Map<string, Route>();
const retired = new Set<string>();
const subscriptions = new Map<string, Promise<unknown>>();
let made = 0;
let load: string | null = null;

export function resetNativeMenus(): void {
  routes.clear();
  retired.clear();
  subscriptions.clear();
  made = 0;
  load = null;
}

function fault(e: AppError): void {
  console.error(e);
  toast(e.message, "bad", `${e.code}\n${detailsOf(e)}`);
}

function guarded(code: string, run: () => void): void {
  try {
    run();
  } catch (e) {
    fault(e instanceof AppError ? e : new AppError(code, e instanceof Error ? e.message : answerOf(e), e));
  }
}

function nextToken(): string {
  load ??= newId();
  made += 1;
  return `menu-${load}-${made}`;
}

const record = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

const filled = (x: unknown): x is string => typeof x === "string" && x !== "";

function chosenOf(payload: unknown): { token: string; id: string } | null {
  if (!record(payload) || Object.keys(payload).length !== 2) return null;
  const { token, id } = payload;
  return filled(token) && filled(id) ? { token, id } : null;
}

function endedOf(payload: unknown): string | null {
  if (!record(payload) || Object.keys(payload).length !== 1) return null;
  const { token } = payload;
  return filled(token) ? token : null;
}

function routeOf(name: string, token: string): Route | null {
  const route = routes.get(token);
  if (route !== undefined) return route;
  if (!retired.has(token)) fault(new AppError("ipc.shape", `${name} named the menu ${JSON.stringify(token)}, which this page did not show`));
  return null;
}

function onChosen(payload: unknown): void {
  const got = chosenOf(payload);
  if (got === null) {
    fault(new AppError("ipc.shape", `menu-chosen carried ${answerOf(payload)} instead of { token: string, id: string }`));
    return;
  }
  if (retired.has(got.token)) {
    fault(new AppError("menu.dropped", `The row ${JSON.stringify(got.id)} was chosen in the menu ${JSON.stringify(got.token)}, which failed to show, so it was not run`));
    return;
  }
  const route = routeOf("menu-chosen", got.token);
  if (route === null || route.chosen) return;
  route.chosen = true;
  if (route.ended) routes.delete(got.token);
  guarded("menu.chosen", () => route.on.chosen(got.id));
}

function onEnded(payload: unknown): void {
  const token = endedOf(payload);
  if (token === null) {
    fault(new AppError("ipc.shape", `menu-ended carried ${answerOf(payload)} instead of { token: string }`));
    return;
  }
  const route = routeOf("menu-ended", token);
  if (route === null || route.ended) return;
  route.ended = true;
  [...routes].filter(([other, r]) => other !== token && r.ended).forEach(([other]) => routes.delete(other));
  if (route.chosen) routes.delete(token);
  guarded("menu.ended", () => route.on.ended());
}

const listened = (name: string, handler: (payload: unknown) => void): Promise<unknown> =>
  listen<unknown>(name, (event) => handler(event.payload)).catch((e: unknown) => {
    throw new AppError("ipc.failed", `listen ${name}: ${e instanceof Error ? e.message : answerOf(e)}`, e);
  });

function subscribedTo(name: string, handler: (payload: unknown) => void): Promise<unknown> {
  const known = subscriptions.get(name);
  if (known !== undefined) return known;
  const asked = listened(name, handler);
  subscriptions.set(name, asked);
  asked.catch(() => {
    if (subscriptions.get(name) === asked) subscriptions.delete(name);
  });
  return asked;
}

const subscribe = (): Promise<unknown> => Promise.all([subscribedTo("menu-chosen", onChosen), subscribedTo("menu-ended", onEnded)]);

function onIos(what: string): void {
  const { os } = readPlatform(window);
  if (os !== "ios") throw new AppError("menu.platform", `A native menu was ${what} on ${os}, where only iOS has one`);
}

export async function showNativeMenu(sections: readonly NativeMenuSection[], anchor: NativeMenuAnchor, on: NativeMenuHandlers): Promise<string> {
  onIos("asked for");
  await subscribe();
  const token = nextToken();
  routes.set(token, { on, chosen: false, ended: false });
  try {
    await callNull("menu_show", { menu: { token, anchor, sections } });
  } catch (e) {
    routes.delete(token);
    retired.add(token);
    throw e;
  }
  return token;
}

export async function dismissNativeMenu(token: string): Promise<void> {
  onIos("dismissed");
  await callNull("menu_dismiss", { token });
}
