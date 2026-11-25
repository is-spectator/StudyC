import { useEffect, useRef, useState } from 'react';
import { Download, FileText, Upload } from 'lucide-react';
import { AuthApiError, isAbortError } from '../auth/api';
import type { SourceFile, StudyApi } from './api';

const statusText: Record<SourceFile['status'], string> = {
  ready: '文字已提取，可打开资料或下载原文件',
  no_extractable_text: '没有可提取的文字。扫描件暂不支持，未保存正文',
  encrypted_pdf: 'PDF 已加密或需要密码，未保存正文',
  invalid_pdf: '文件损坏或不是有效的 PDF，未保存正文',
  text_too_large: '提取出的文字超过 1 MiB，未保存正文',
  too_many_pages: 'PDF 超过 30 页，未保存正文',
};

function message(error: unknown): string {
  if (error instanceof AuthApiError) return error.message;
  if (isAbortError(error)) return '上传已取消。';
  return '上传没有完成，请重试。';
}

export type PdfFileListState = { studySetId: string; files: SourceFile[]; loading: boolean; loaded: boolean; error: string };
export default function PdfUpload({ api, studySetId, onExtracted, hideRecords = false, filesRevision = 0, onFileListChange }: { api: StudyApi; studySetId: string; onExtracted: () => void; hideRecords?: boolean; filesRevision?: number; onFileListChange?: (state: PdfFileListState) => void }) {
  const [fileList, setFileList] = useState<PdfFileListState>({ studySetId, files: [], loading: true, loaded: false, error: '' });
  const [refreshFiles, setRefreshFiles] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const pending = useRef<{ id: string; name: string; size: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const scope = useRef(studySetId);
  scope.current = studySetId;
  const additions = useRef(new Map<string, SourceFile>());
  const visibleFiles = fileList.studySetId === studySetId ? fileList : { studySetId, files: [], loading: true, loaded: false, error: '' };

  useEffect(() => {
    pending.current = null;
    setBusy(false); setNotice(''); setError('');
  }, [studySetId]);

  useEffect(() => {
    const controller = new AbortController();
    // Preserve uploads that finish after this list request starts.
    const uploaded = new Map<string, SourceFile>();
    additions.current = uploaded;
    setFileList(current => ({ studySetId, files: current.studySetId === studySetId ? current.files : [], loading: true, loaded: false, error: '' }));
    void api.listFiles(studySetId, controller.signal).then(items => {
      if (!controller.signal.aborted) {
        const files = [...uploaded.values(), ...items.filter(item => !uploaded.has(item.id))];
        setFileList({ studySetId, files, loading: false, loaded: true, error: '' });
      }
    }).catch(reason => {
      if (!controller.signal.aborted && !isAbortError(reason)) setFileList(current => ({ ...current, loading: false, loaded: false, error: reason instanceof Error ? reason.message : '上传记录暂时无法读取，请重试。' }));
    });
    return () => controller.abort();
  }, [api, studySetId, filesRevision, refreshFiles]);

  useEffect(() => { onFileListChange?.(fileList); }, [fileList, onFileListChange]);

  async function upload(file: File) {
    if (!pending.current || pending.current.name !== file.name || pending.current.size !== file.size) {
      pending.current = { id: crypto.randomUUID(), name: file.name, size: file.size };
    }
    setBusy(true); setError(''); setNotice('正在提取 PDF 文字…');
    try {
      const saved = await api.uploadPdf(studySetId, file, pending.current.id);
      if (scope.current !== studySetId) return;
      pending.current = null;
      additions.current.set(saved.id, saved);
      // A successful upload does not prove the rest of the file list loaded.
      setFileList(current => current.studySetId === studySetId ? { ...current, files: [saved, ...current.files.filter(item => item.id !== saved.id)] } : current);
      setNotice(saved.status === 'ready' ? `已从「${saved.displayName}」提取文字。` : statusText[saved.status]);
      if (saved.status === 'ready') onExtracted();
    } catch (reason) {
      if (scope.current !== studySetId) return;
      if (reason instanceof AuthApiError && (reason.status === 422 || reason.status === 409 || reason.status === 400 || reason.status === 413)) pending.current = null;
      setError(message(reason));
      setNotice('');
      if (reason instanceof AuthApiError && (reason.status === 422 || reason.status === 409)) {
        setRefreshFiles(value => value + 1);
      }
    } finally { if (scope.current === studySetId) { setBusy(false); if (input.current) input.current.value = ''; } }
  }

  async function download(file: SourceFile) {
    setError('');
    try {
      const blob = await api.downloadPdf(studySetId, file.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = file.displayName; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) { setError(message(reason)); }
  }

  return <section className="cloud-pdf-section" aria-label="上传 PDF">
    <div className="section-heading"><h2><Upload size={18} />上传 PDF</h2>
      <label className={`btn ${busy ? 'is-disabled' : ''}`}>选择 PDF<input ref={input} className="cloud-pdf-input" type="file" accept="application/pdf,.pdf" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); }} /></label>
    </div>
    <p className="cloud-pdf-note">支持含文字的 PDF（最大 8 MB、30 页）。扫描件和加密文件暂不支持。</p>
    {!hideRecords && visibleFiles.loading ? <p className="cloud-pdf-note" role="status">正在读取上传记录…</p> : null}
    {!hideRecords && visibleFiles.error ? <div className="cloud-pdf-error" role="alert"><p>{visibleFiles.error}</p><button type="button" className="btn" onClick={() => setRefreshFiles(value => value + 1)}>重新读取上传记录</button></div> : null}
    {notice ? <p className="cloud-pdf-note" role="status">{notice}</p> : null}
    {error ? <p className="cloud-pdf-error" role="alert">{error}</p> : null}
    {!hideRecords ? <div className="cloud-pdf-list">{visibleFiles.files.map(file => <article key={file.id} className={`cloud-pdf-item is-${file.status}`} data-source-file-id={file.id}>
      <FileText size={18} />
      <span><strong>{file.displayName}</strong><small>{statusText[file.status]}{file.pageCount ? ` · ${file.pageCount} 页` : ''}</small></span>
      {file.status === 'ready' ? <button className="btn" type="button" onClick={() => void download(file)}><Download size={15} />下载原文件</button> : null}
    </article>)}</div> : null}
  </section>;
}
