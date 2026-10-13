import {useState} from "react";
import {Eye, EyeOff, ShieldAlert} from "lucide-react";
import {Button} from "@/components/ui/button";

export function RecoveryWarning() {
  return <div className="recovery-warning" role="alert"><ShieldAlert aria-hidden="true"/>
    <div><strong>Keep your recovery details secret</strong><p>Anyone with your recovery phrase or private key can access
      your account and take your funds. Never share them or enter them on another website.</p></div>
  </div>;
}

export function RecoveryBackup({backup, onHide}: { backup: string; onHide: () => void }) {
  const [visible, setVisible] = useState(false);
  return <section className="recovery-reveal">
    <RecoveryWarning/>
    <div className="recovery-secret-card">
      <div className="recovery-secret-heading"><strong>Recovery details</strong><Button icon={visible ? EyeOff : Eye}
                                                                                        variant="secondary" size="sm"
                                                                                        aria-pressed={visible}
                                                                                        onClick={() => setVisible(value => !value)}>{visible ? "Blur recovery material" : "Show recovery material"}</Button>
      </div>
      {visible ? <pre>{backup}</pre> : <>
        <pre className="recovery-blurred"
             aria-hidden="true">{"•••• •••• •••• •••• •••• ••••\n•••• •••• •••• •••• •••• ••••\n\n••••••••••••••••••••••••••••••••"}</pre>
        <p className="muted" role="status">Recovery details are blurred. Show them only when you are somewhere
          private.</p></>}
    </div>
    <div className="dialog-actions"><Button icon={EyeOff} variant="ghost" onClick={onHide}>Hide recovery
      material</Button></div>
  </section>;
}
