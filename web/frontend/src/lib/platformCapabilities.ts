/** One capability registry for creation, calendar plans, manual delivery and submission.
 * A calendar plan never implies an automatic publisher (notably Weibo).
 */
export interface PlatformCapability {
  key: string; label: string; aliases: string[];
  creation: boolean; schedule: boolean; manual: boolean; automated: boolean;
  titleLimit: number; bodyLimit: number; hint: string; url: string;
  draft: boolean; mediaRequired: boolean; videoOnly: boolean;
}
function platform(key: string, label: string, titleLimit: number, bodyLimit: number, url: string, hint: string,
  options: Partial<PlatformCapability> = {}): PlatformCapability {
  return Object.freeze({ key, label, titleLimit, bodyLimit, url, hint, aliases: [],
    creation: true, schedule: true, manual: true, automated: true,
    draft: false, mediaRequired: false, videoOnly: false, ...options });
}
export const PLATFORM_CAPABILITIES: readonly PlatformCapability[] = Object.freeze([
  platform('generic', '通用', 0, 20000, '', '仅用于通用母稿创作。', { schedule: false, manual: false, automated: false }),
  platform('xiaohongshu', '小红书', 20, 1000, 'https://creator.xiaohongshu.com/publish/publish?source=official', '核对图文或视频、封面和话题；标题≤20，正文≤1000。', { mediaRequired: true }),
  platform('wechat-oa', '公众号', 64, 20000, 'https://mp.weixin.qq.com/', '自动提交只创建公众号草稿；官方发布前检查图片与手机预览。', { aliases: ['微信公众号'], mediaRequired: true }),
  platform('douyin', '抖音', 55, 55, 'https://creator.douyin.com/', '自动链路仅视频；核对描述、封面与素材，文案≤55。', { mediaRequired: true, videoOnly: true }),
  platform('weixin-channels', '视频号', 0, 1000, 'https://channels.weixin.qq.com/platform/post/create', '视频号助手上传视频，检查预览和话题。', { aliases: ['微信视频号'], mediaRequired: true, videoOnly: true }),
  platform('bilibili', 'B站', 80, 2000, 'https://member.bilibili.com/', '需附视频，核对分区、简介和封面。', { mediaRequired: true, videoOnly: true }),
  platform('weibo', '微博', 0, 2000, '', '支持创作与日历计划，尚无站内发布集成；请自行到微博发布并人工回填。', { manual: false, automated: false }),
  platform('zhihu', '知乎', 0, 5000, 'https://zhuanlan.zhihu.com/write', '打开文章编辑器，粘贴正文并检查逻辑与排版。'),
  platform('kuaishou', '快手', 30, 1000, 'https://cp.kuaishou.com/article/publish/video', '视频或图片，标题≤30；自动提交需附媒体。', { mediaRequired: true }),
  platform('toutiao', '今日头条', 30, 10000, 'https://mp.toutiao.com/profile_v4/graphic/publish', '图文标题≤30，话题≤5；可保存到头条草稿箱。', { draft: true }),
  platform('juejin', '掘金', 100, 20000, 'https://juejin.cn/editor/drafts/new?v=2', 'Markdown 技术文章；核对分类、已有标签和摘要。'),
  platform('twitter-x', 'X', 0, 280, 'https://x.com/compose/post', '标题与正文合并，最终长度以 X 校验为准；可附图片或视频。', { aliases: ['推特 X', 'Twitter', '推特'] }),
]);
export const CREATION_PLATFORMS = PLATFORM_CAPABILITIES.filter(p => p.creation).map(p => p.label);
export const SCHEDULE_PLATFORMS = PLATFORM_CAPABILITIES.filter(p => p.schedule).map(p => p.label);
export const MANUAL_PLATFORMS = PLATFORM_CAPABILITIES.filter(p => p.manual);
export const AUTOMATED_PLATFORMS = PLATFORM_CAPABILITIES.filter(p => p.automated);
export function platformCapability(value: string) {
  return PLATFORM_CAPABILITIES.find(p => p.key === value || p.label === value || p.aliases.includes(value));
}
export function platformNotice(value: string) {
  const p = platformCapability(value);
  return p && !p.manual && !p.automated ? p.hint : '';
}
