import { authUrl } from "../api.ts";
import { Logo } from "./ui.tsx";

export function Login() {
  return (
    <div className="center">
      <div className="card login">
        <h1><Logo /> Manta</h1>
        <p className="muted">Engineering orchestrator.</p>
        <a className="btn primary" href={authUrl}>Sign in with Google</a>
      </div>
    </div>
  );
}
