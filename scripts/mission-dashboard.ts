import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadSomaProfile } from "../src/home/soma-home";
import { GOAL_STATUSES } from "../src/goal-records";
import type { GoalRecord, GoalRecordWarning } from "../src/goal-records";
import { DEFAULT_VIGIL_URL, readSensorSource, sensorReading, validateVigilUrl, type SensorSourceOptions } from "./dashboard-sensors";

/** Local, read-only prototype. Private profile data is never bundled into assets. */
export async function dashboardSnapshot(somaHome: string, options: SensorSourceOptions = {}) {
  const warnings: GoalRecordWarning[] = [];
  const profile = await loadSomaProfile(somaHome, { onGoalWarning: (warning) => warnings.push(warning) });
  const source = await readSensorSource(options);
  return {
    loadedAt: new Date().toISOString(),
    principal: profile.principal.preferredName ?? profile.principal.name,
    purpose: profile.purpose.mission ?? "",
    missions: profile.purpose.missions.map((text, index) => {
      const match = /^(M\d+)\s*(?:[—–:-]\s*)?(.*)$/s.exec(text);
      return { id: match?.[1] ?? `mission-${index}`, wording: match?.[2] ?? text };
    }),
    // Expose only fields used by the view; keep private body text behind the detail request.
    goals: (profile.purpose.goals ?? []).map(({ body: _body, ...goal }) => ({ ...goal, sensorReading: sensorReading(goal, source) })),
    sensorSource: { name: "Vigil", status: source.status, checkedAt: source.checkedAt, message: source.message },
    statuses: GOAL_STATUSES,
    warnings,
  };
}

export function startDashboard(somaHome: string, port: number, options: SensorSourceOptions = {}) {
  const asset = Bun.file(join(import.meta.dir, "mission-dashboard.html"));
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request, server) {
      const url = new URL(request.url);
      const headers = {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      };
      const respond = (body: unknown, status = 200) => Response.json(body, { status, headers });
      // Reject rebinding and cross-site navigation to this private local surface.
      if (url.host !== `127.0.0.1:${server.port}`) return respond({ error: "Invalid local host." }, 403);
      if (request.headers.get("sec-fetch-site") === "cross-site") return respond({ error: "Local access only." }, 403);
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) return respond({ error: "Local access only." }, 403);
      if (request.method !== "GET") return respond({ error: "This dashboard is read-only." }, 405);
      if (url.pathname === "/") return new Response(asset, { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
      try {
        if (url.pathname === "/api/dashboard") return respond(await dashboardSnapshot(somaHome, options));
        const match = /^\/api\/goals\/(G\d+)$/.exec(url.pathname);
        if (match) {
          const profile = await loadSomaProfile(somaHome, { onGoalWarning: () => undefined });
          const goal: GoalRecord | undefined = profile.purpose.goals?.find((item) => item.id === match[1]);
          if (!goal) return respond({ error: "Goal not found." }, 404);
          const source = await readSensorSource(options);
          return respond({ ...goal, sensorReading: sensorReading(goal, source) });
        }
        return respond({ error: "Not found." }, 404);
      } catch (error) {
        console.error("Dashboard read failed:", error instanceof Error ? error.name : typeof error);
        return respond({ error: "Could not read Soma records. Check the selected Soma home and file permissions, then refresh." }, 500);
      }
    },
  });
}

if (import.meta.main) {
  const somaHome = resolve(process.env.SOMA_HOME ?? join(homedir(), ".soma"));
  const port = Number(process.env.SOMA_DASHBOARD_PORT ?? "4318");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SOMA_DASHBOARD_PORT must be between 1 and 65535.");
  // Custom homes opt into their observation source rather than mixing profiles.
  const vigilUrl = process.env.SOMA_DASHBOARD_VIGIL_URL ?? (process.env.SOMA_HOME ? undefined : DEFAULT_VIGIL_URL);
  if (vigilUrl) validateVigilUrl(vigilUrl);
  startDashboard(somaHome, port, { vigilUrl });
  console.log(`Soma dashboard: http://127.0.0.1:${port} (read-only)`);
}
