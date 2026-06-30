// Desktop provider registration.
//
// Two of the three providers (GitLab, YouTrack) are pure REST and live in @shot2issue/core —
// once core's injected fetch is bound (initCore), they work unchanged. GitHub is host-owned:
// on desktop it rides the github.com web-session cookie through Rust commands (see
// ./github.ts + src-tauri/src/services/github.rs), so its impl can't live in the
// platform-free core. We assemble all three here and hand them to core's registry at boot.

import { registerProviders, gitlabProvider, youtrackProvider } from "@shot2issue/core";
import { githubProvider } from "./github";

/** Register GitHub + GitLab + YouTrack in core's registry. Call once at boot (after initCore). */
export function registerAllProviders(): void {
  // Order = order shown in the target selector (GitHub first, mirroring the extension).
  registerProviders([githubProvider, youtrackProvider, gitlabProvider]);
}
