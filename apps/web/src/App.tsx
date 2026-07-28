import { useEffect, useState } from "react";
import { useStore } from "@nanostores/react";
import { $me } from "./stores.ts";
import { loadMe } from "./actions.ts";
import { captureInviteCode } from "./lib/invite.ts";
import { capturePairRequest, type PairRequest } from "./lib/pairing.ts";
import { useOpenExternalLinksOutsideManta } from "./lib/markdown.ts";
import { installAppNotificationClearing } from "./lib/appBadge.ts";
import { Login } from "./components/Login.tsx";
import { PairWorker } from "./components/PairWorker.tsx";
import { AcceptInvite } from "./components/AcceptInvite.tsx";
import { WorkspacePicker } from "./components/WorkspacePicker.tsx";
import { Shell } from "./components/Shell.tsx";
import { TranscriptPage } from "./components/TranscriptPage.tsx";
import { Toasts } from "./components/Toasts.tsx";
import { BlackMantaCommentator } from "./components/BlackMantaCommentator.tsx";

function isTranscriptRoute() {
  return window.location.pathname.startsWith("/transcripts/");
}

export function App() {
  useOpenExternalLinksOutsideManta();
  const me = useStore($me);
  const [inviteCode, setInviteCode] = useState<string | null>(() => captureInviteCode());
  const [pairReq, setPairReq] = useState<PairRequest | null>(() => capturePairRequest());
  useEffect(() => { void loadMe(); }, []);
  useEffect(() => installAppNotificationClearing(), []);
  if (me === undefined) return <div className="center muted">Loading…</div>;
  if (me === null) return <Login />;
  // Pairing takes priority once logged in (it survives the OAuth round-trip).
  if (pairReq) return <PairWorker req={pairReq} onCancel={() => setPairReq(null)} />;
  if (inviteCode) return <AcceptInvite code={inviteCode} onClose={() => setInviteCode(null)} />;
  if (isTranscriptRoute()) return <><TranscriptPage /><Toasts /></>;
  if (me.memberships.length === 0) return <WorkspacePicker />;
  return <><Shell /><BlackMantaCommentator /><Toasts /></>;
}
