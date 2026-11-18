import { useEffect, useState } from 'react';
import { fetchWorkbenchEngines, saveWorkbenchSearchSettings } from '../lib/api';
import type { WorkbenchEngines as Engines } from '../lib/api';

export default function WorkbenchEngines({onSearchReady, readOnly = false}: {onSearchReady?: (ready:boolean)=>void; readOnly?:boolean}) {
  const [info, setInfo] = useState<Engines | null>(null);
  const [provider, setProvider] = useState('codex');
  const [key, setKey] = useState('');
  const [clear, setClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const apply = (value: Engines) => {
    setInfo(value); setProvider(value.search.provider);
    onSearchReady?.(Boolean(value.search.providers.find(p => p.id === value.search.provider)?.configured));
  };
  useEffect(() => {
    let active = true;
    fetchWorkbenchEngines().then(value => { if (active) apply(value); }).catch(() => { if (active) setNotice('搜索通道状态读取失败，请刷新重试。'); });
    return () => { active = false; };
  }, []);
  const save = async () => {
    setBusy(true); setNotice('');
    try {
      await saveWorkbenchSearchSettings({ provider, ...(key ? {api_key:key} : {}), clear_key:clear });
      apply(await fetchWorkbenchEngines());
      setKey(''); setClear(false); setNotice('已保存并读回搜索设置；分析模型未改变。');
    } catch (e) { setNotice(e instanceof Error ? e.message : '搜索设置保存失败'); }
    finally { setBusy(false); }
  };
  const selected = info?.search.providers.find(p => p.id === info.search.provider);
  return <div className="workbench-engine-settings">
    <p className="workbench-meta">联网检索通道：{selected?.label || '读取中'}{selected && !selected.configured ? '（未配置，不会偷偷换通道）' : ''}。AI分析通道：{info ? `${info.analysis.label} / ${info.analysis.model || '底座默认模型'}` : '读取中'}。</p>
    {!readOnly && <details><summary>搜索通道设置（与分析模型独立）</summary>
      <label>搜索供应商<select aria-label="搜索供应商" value={provider} onChange={e => setProvider(e.target.value)}><option value="codex">Codex 联网检索</option><option value="deepseek">DeepSeek Search API</option></select></label>
      <p className="workbench-muted">DeepSeek Search API与DeepSeek聊天分析是两项能力。Codex使用本机登录与已选Codex模型；DeepSeek Search只请求官方搜索接口，不复用Codex密钥。</p>
      {provider === 'deepseek' && <>
        <label>DeepSeek Search Key<input type="password" autoComplete="off" aria-label="DeepSeek Search Key" value={key} onChange={e => setKey(e.target.value)} placeholder={info?.search.key_configured ? '已配置，留空保持不变' : '仅保存到本机私有配置'} /></label>
        <label><input type="checkbox" checked={clear} onChange={e => setClear(e.target.checked)} />清除本机保存的Key（不修改环境变量）</label>
      </>}
      <button type="button" onClick={save} disabled={busy}>{busy ? '保存搜索设置中…' : '保存搜索设置'}</button>
    </details>}
    {notice && <p role="status" className="workbench-notice">{notice}</p>}
  </div>;

}
