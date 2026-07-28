import { useEffect, useState } from "react";

interface SlashCommand {
  name: string;
  description: string;
}

const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: "/compact", description: "Compact Pi context to free up space" },
  { name: "/new", description: "Start a new brain session" },
];

const skillsCache = new Map<string, SlashCommand[]>();

async function loadSkills(workspaceId: string): Promise<SlashCommand[]> {
  if (skillsCache.has(workspaceId)) return skillsCache.get(workspaceId)!;
  try {
    const r = await fetch(`/api/workspaces/${workspaceId}/skills`);
    if (!r.ok) return [];
    const data = await r.json() as { skills?: Array<{ name: string; repo: string }> };
    const skills: SlashCommand[] = (data.skills ?? []).map((s) => ({
      name: `/${s.name}`,
      description: `Skill from ${s.repo}`,
    }));
    skillsCache.set(workspaceId, skills);
    return skills;
  } catch {
    return [];
  }
}

/** Returns the slash query at the cursor (text after the slash) or null if not in a slash context. */
export function getSlashQuery(value: string, cursorPos: number): string | null {
  const before = value.slice(0, cursorPos);
  const m = before.match(/(^|[\s])\/([\w-]*)$/);
  return m ? (m[2] ?? "") : null;
}

export function useSlashCommands(workspaceId: string | null, query: string | null): SlashCommand[] {
  const [skills, setSkills] = useState<SlashCommand[]>([]);
  const isSlashActive = query !== null;

  useEffect(() => {
    let cancelled = false;
    if (!isSlashActive || !workspaceId) {
      setSkills([]);
      return;
    }
    void loadSkills(workspaceId).then((loadedSkills) => {
      if (!cancelled) setSkills(loadedSkills);
    });
    return () => { cancelled = true; };
  }, [workspaceId, isSlashActive]);

  if (!isSlashActive) return [];
  const allCommands = [...BUILTIN_COMMANDS, ...skills];
  const q = query.toLowerCase();
  return q
    ? allCommands.filter((c) => c.name.slice(1).toLowerCase().startsWith(q) || c.name.slice(1).toLowerCase().includes(q))
    : allCommands;
}

export interface SlashMenuProps {
  commands: SlashCommand[];
  selIdx: number;
  onSelect: (command: string) => void;
}

export function SlashMenu({ commands, selIdx, onSelect }: SlashMenuProps) {
  if (commands.length === 0) return null;
  return (
    <div className="slash-dropdown">
      {commands.map((cmd, i) => (
        <div
          key={`${cmd.name}:${cmd.description}:${i}`}
          className={`slash-item${i === selIdx ? " selected" : ""}`}
          onMouseDown={(e) => { e.preventDefault(); onSelect(cmd.name); }}
        >
          <span className="slash-item-name">{cmd.name}</span>
          <span className="slash-item-desc">{cmd.description}</span>
        </div>
      ))}
    </div>
  );
}
