interface ConfirmDialogProps {
  title: string;
  body: string;
  objectName?: string;
  cancelLabel: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function ConfirmDialog({ title, body, objectName, cancelLabel, confirmLabel, onCancel, onConfirm }: ConfirmDialogProps) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-dialog confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="confirm-dialog-title">{title}</h2>
        <p className="modal-body-text">{body}</p>
        {objectName && <div className="confirm-dialog-object" title={objectName}>{objectName}</div>}
        <div className="modal-actions">
          <button className="modal-btn modal-btn-cancel" onClick={onCancel} type="button">{cancelLabel}</button>
          <button className="modal-btn modal-btn-danger" onClick={onConfirm} type="button">{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
