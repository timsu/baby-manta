import { useEffect, useMemo, useState } from "react";
import { useStore } from "@nanostores/react";
import { $cards, $me, $openTaskId, $pendingUserQuestions, type PendingUserQuestion } from "../stores.ts";
import { answerUserQuestionWs, dismissUserQuestionWs, openTask } from "../ws.ts";

function answerFor(selection: Record<number, string[]>) {
  return Object.entries(selection)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, labels]) => labels.join(", "))
    .filter(Boolean)
    .join("\n");
}

function UserQuestionMenu({ item }: { item: PendingUserQuestion }) {
  const cards = useStore($cards);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initial = useMemo(() => Object.fromEntries(item.questions.map((q, i) => [i, q.multiSelect ? [] : [q.options[0]?.label ?? ""]])), [item.questions]);
  const [selection, setSelection] = useState<Record<number, string[]>>(initial as Record<number, string[]>);
  const card = cards.find((c) => c.id === item.taskId);
  const answer = answerFor(selection);
  // The server settles every submission with `user_question_resolved`, which
  // unmounts this menu. If that never arrives (socket dropped mid-send), release
  // the button instead of leaving it on "Sending…" forever.
  useEffect(() => {
    if (!submitting) return;
    const timer = setTimeout(() => {
      setSubmitting(false);
      setError("No response — check your connection and try again.");
    }, 15_000);
    return () => clearTimeout(timer);
  }, [submitting]);

  const send = (deliver: () => boolean) => {
    if (submitting) return;
    setError(null);
    if (deliver()) setSubmitting(true);
    else setError("Not connected — try again in a moment.");
  };
  const submit = (nextAnswer: string) => send(() => answerUserQuestionWs(item.questionId, item.taskId, nextAnswer));
  const dismiss = () => send(() => dismissUserQuestionWs(item.questionId, item.taskId));

  return (
    <section className="user-question-menu" aria-label="Worker question">
      <div className="user-question-head">
        <button className="user-question-card" onClick={() => { $openTaskId.set(item.taskId); openTask(item.taskId); }}>
          {card?.title ?? item.taskId}
        </button>
        <button className="user-question-dismiss" title="Dismiss" aria-label="Dismiss question" disabled={submitting} onClick={dismiss}>×</button>
      </div>
      {item.questions.map((q, qi) => (
        <div key={qi} className="user-question-block">
          <div className="user-question-header">{q.header}</div>
          <div className="user-question-text">{q.question}</div>
          <div className="user-question-options">
            {q.options.map((opt) => {
              const selected = selection[qi]?.includes(opt.label) ?? false;
              return (
                <button
                  key={opt.label}
                  className={`user-question-option ${selected ? "selected" : ""}`}
                  title={opt.description}
                  onClick={() => setSelection((current) => {
                    const prev = current[qi] ?? [];
                    return {
                      ...current,
                      [qi]: q.multiSelect
                        ? (prev.includes(opt.label) ? prev.filter((v) => v !== opt.label) : [...prev, opt.label])
                        : [opt.label],
                    };
                  })}
                >
                  <span>{opt.label}</span>
                  {opt.description && <small>{opt.description}</small>}
                  {opt.preview && <pre>{opt.preview}</pre>}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {error && <div className="user-question-error" role="alert">{error}</div>}
      <button className="btn primary user-question-submit" disabled={!answer || submitting} onClick={() => submit(answer)}>
        {submitting ? "Sending…" : "Send answer"}
      </button>
    </section>
  );
}

export function UserQuestionMenus() {
  const pending = useStore($pendingUserQuestions);
  const me = useStore($me);
  const visiblePending = pending.filter((q) => {
    return q.ownerUserId === null || !me || q.ownerUserId === me.id;
  });
  if (!visiblePending.length) return null;
  return <div className="user-question-stack">{visiblePending.map((q) => <UserQuestionMenu key={q.questionId} item={q} />)}</div>;
}
