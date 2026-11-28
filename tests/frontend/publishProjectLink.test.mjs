import assert from 'node:assert/strict';
import {test} from 'node:test';
import {publishHarness} from './publishHarness.mjs';

const source = {persona: '甲', task_id: 'project', version_id: 'version'};
const original = {title: '公众号', body: '已编辑公众号正文', tags: '', platforms: ['wechat-oa'], overrides: {}, project_source: source};

for (const file of ['PublishPage', 'ManualPublishPage']) {
  test(file + '清空文案同时解除项目关联并移除当前草稿副本', async () => {
    const harness = publishHarness(file);
    harness.store.savePublishDraft(original, '甲');
    await harness.flush();
    harness.button(file === 'PublishPage' ? '清空' : '清空文案').props.onClick();
    await harness.flush();
    assert.equal(harness.store.loadPublishDraft('甲').project_source, undefined);
    assert.equal(harness.store.readSavedPublishDraft('甲', source, undefined), undefined);
  });

  test(file + '切换和恢复项目发布草稿，同时分开录制稿与发布文案', async () => {
    const harness = publishHarness(file);
    harness.store.savePublishDraft(original, '甲');
    await harness.flush();
    const next = {...source, version_id: 'oral-version', title: '抖音', text: '', versionName: '抖音口播稿',
      platform: '抖音', script: '这段正文仅用来录制。'};
    harness.render().find(node => node.type === 'project-source').props.onImport(next);
    await harness.flush();
    assert.equal(harness.store.loadPublishDraft('甲').script, next.script);
    assert.equal(harness.store.loadPublishDraft('甲').body, '');
    const saved = harness.store.listSavedPublishDrafts('甲');
    assert.equal(saved[0].draft.body, original.body);
    harness.render().find(node => node.type === 'draft-picker').props.onOpen(saved[0].draft);
    await harness.flush();
    assert.equal(harness.store.loadPublishDraft('甲').body, original.body);
    assert.equal(harness.store.loadPublishDraft('甲').script, undefined);
    harness.store.removeDeletedProjectDrafts('甲', [source.task_id]);
    assert.equal(harness.store.loadPublishDraft('甲').project_source, undefined);
    assert.equal(harness.store.listSavedPublishDrafts('甲').length, 0);
  });
}
