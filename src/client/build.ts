declare const BUILD_ID: string | undefined;

const CLIENT_BUILD = typeof BUILD_ID === "string" ? BUILD_ID : "dev";
const RELOAD_STORAGE = "tlo-reloaded-for";

export function reloadIfOutdated(serverBuild: string | undefined, canReload: () => boolean) {
  if (!serverBuild || serverBuild === "dev" || CLIENT_BUILD === "dev") return false;
  if (serverBuild === CLIENT_BUILD) return false;
  if (sessionStorage.getItem(RELOAD_STORAGE) === serverBuild || !canReload()) return false;
  sessionStorage.setItem(RELOAD_STORAGE, serverBuild);
  location.reload();
  return true;
}

export function watchBuild(canReload: () => boolean) {
  if (CLIENT_BUILD === "dev") return;
  const check = async () => {
    try {
      const res = await fetch("/api/version", { cache: "no-store" });
      if (!res.ok) return;
      const { build } = (await res.json()) as { build?: string };
      reloadIfOutdated(build, canReload);
    } catch {}
  };
  window.setInterval(check, 30_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void check();
  });
}
