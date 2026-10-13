import {type FormEvent, useState} from "react";
import {Check, Pencil, X} from "lucide-react";
import {Button} from "@/components/ui/button";
import {ACCOUNT_NAME_MAX_LENGTH} from "./account-names";

export function AccountNameLabel({name}: { name: string }) {
  const characters = Array.from(name), truncated = characters.length > 18;
  const displayName = truncated ? `${characters.slice(0, 18).join("")}…` : name;
  return <strong title={truncated ? name : undefined} aria-label={truncated ? name : undefined}>{displayName}</strong>;
}

export function AccountName({name, disabled, onSave}: {
  name: string;
  disabled: boolean;
  onSave: (name: string) => void
}) {
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(name), [error, setError] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled) return;
    try {
      onSave(draft);
      setEditing(false);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the account name.");
    }
  }

  return editing ? <form className="wallet-account-name-editor" onSubmit={submit}>
    <input aria-label="Account name" autoFocus required maxLength={ACCOUNT_NAME_MAX_LENGTH} value={draft}
           disabled={disabled} onChange={event => setDraft(event.target.value)} onKeyDown={event => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setEditing(false);
      }
    }}/>
    <Button type="submit" icon={Check} size="icon" title="Save" aria-label="Save" disabled={disabled || !draft.trim()}/>
    <Button icon={X} variant="ghost" size="icon" title="Cancel" aria-label="Cancel" disabled={disabled}
            onClick={() => setEditing(false)}/>
    {error && <p role="alert">{error}</p>}
  </form> : <span className="wallet-account-name"><AccountNameLabel name={name}/><Button icon={Pencil} variant="ghost"
                                                                                         size="icon"
                                                                                         title="Rename account"
                                                                                         aria-label={`Rename ${name}`}
                                                                                         disabled={disabled}
                                                                                         onClick={() => {
                                                                                           setDraft(name);
                                                                                           setError("");
                                                                                           setEditing(true);
                                                                                         }}/></span>;
}
