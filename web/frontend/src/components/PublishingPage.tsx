import { useEffect, useState } from 'react';
import { fetchPublishingPolicy, fetchWorkbench, fetchWorkbenchVersions } from '../lib/api';
import type { PublishingPolicy } from '../lib/api';
import { loadPublishDraft, recoverableLegacyPublishDraft, removeDeletedProjectDrafts, savePublishDraft } from '../lib/store';
import { splitArticleHeading, withoutRepeatedArticleHeading } from '../lib/article';
import AutomatedPublishPage from './PublishPage';
import ManualPublishPage from './ManualPublishPage';
import type { ProjectPublishProps } from './ProjectPublishSource';
export type { ProjectPublishDraft } from './ProjectPublishSource';

export default function PublishingPage(props: ProjectPublishProps) {
  const { persona } = props;
  const [policy, setPolicy] = useState<PublishingPolicy | null>(null);
  const [mode, setMode] = useState<PublishingPolicy['mode']>('automated');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [calendarHandoff] = useState(!!props.projectDraft?.scheduleId);
  const [draftReadyFor, setDraftReadyFor] = useState<string | null>(null);
  useEffect(() => {
    const draft = loadPublishDraft(persona);
    const source = draft.project_source;
    let active = true;
    if (!source && !recoverableLegacyPublishDraft(persona)?.project_source) {
      setDraftReadyFor(persona);
    } else {
      fetchWorkbench(persona)
        .then(async workbench => {
          if (!active) return;
          const deleted = workbench.deleted_tasks ?? [];
          removeDeletedProjectDrafts(persona, deleted);
          if (!source || draft.articleTitleSet || deleted.includes(source.task_id)) return;
          const project = workbench.tasks.find(task => task.task_id === source.task_id);
          if (!project || project.title !== draft.title) return;
          const versions = await fetchWorkbenchVersions(persona, source.task_id);
          const version = versions.items.find(item => item.id === source.version_id);
          const title = version?.article_title ?? (version && splitArticleHeading(version.text).title);
          if (!active || !title || JSON.stringify(draft) !== JSON.stringify(loadPublishDraft(persona))) return;
          const overrides = Object.fromEntries(Object.entries(draft.overrides)
            .map(([platform, text]) => [platform, withoutRepeatedArticleHeading(text, title)]));
          savePublishDraft({...draft, title, body: withoutRepeatedArticleHeading(draft.body, title),
            overrides, articleTitleSet: true}, persona);
        }).catch(() => {}).finally(() => {
          if (active) setDraftReadyFor(persona);
        });
    }
    return () => { active = false; };
  }, [persona]);
  useEffect(() => {
    let active = true;
    setError('');
    fetchPublishingPolicy().then((value) => {
      if (active) {
        setPolicy(value);
        setMode(value.mode === 'automated' && value.automaticSubmission && !calendarHandoff ? 'automated' : 'manual');
      }
    })
      .catch(() => { if (active) setError('无法读取发布方式，请重试。'); });
    return () => { active = false; };
  }, [retry, calendarHandoff]);
  if (error) return <div className="panel" role="alert">{error}
    <button className="btn btn-sm" onClick={() => setRetry((value) => value + 1)}>重新读取</button>
  </div>;
  if (!policy) return <div className="dash-empty">正在读取发布方式…</div>;
  if (draftReadyFor !== persona) return <div role="status" className="dash-empty">正在读取发布草稿…</div>;
  const automaticAllowed = policy.mode === 'automated' && policy.automaticSubmission;
  const manual = mode === 'manual' || !automaticAllowed;
  return <div className="publishing-workspace">
    <div className="publishing-mode-bar">
      <div className="subnav-tabs" role="group" aria-label="发布方式">
        <button type="button" className={`subnav-tab ${!manual ? 'active' : ''}`}
          aria-pressed={!manual} disabled={!automaticAllowed} onClick={() => setMode('automated')}>
          自动发布
        </button>
        <button type="button" className={`subnav-tab ${manual ? 'active' : ''}`}
          aria-pressed={manual} onClick={() => setMode('manual')}>
          人工审核发布
        </button>
      </div>
      <span className="pv-hint">{!automaticAllowed
        ? '公开发布需到官方页面完成。支持的平台可在审核后保存草稿。'
        : manual ? '审核后复制或导出，前往官方页面亲自提交；切换不更改全局自动发布权限。'
          : '保留原有账号检查、预检、确认及自动提交流程。'}</span>
    </div>
    <div className="publishing-mode-content">
      {manual ? <ManualPublishPage key={persona} {...props} /> : <AutomatedPublishPage key={persona} {...props} />}
    </div>
  </div>;
}
