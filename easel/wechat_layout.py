"""Shared WeChat article rendering for preview, export and platform drafts."""
import html
import re
from importlib import import_module


THEMES = {
    'minimal-bw': ('#242424', '#535353', '#eeeeea', 'sans-serif'),
    'refined-blue': ('#1e3765', '#284e82', '#edf3fa', 'sans-serif'),
    'warm-editorial': ('#352923', '#873e2d', '#f6eee3', "'Songti SC', 'SimSun', serif"),
}
DEFAULT_THEME = 'minimal-bw'


def render_article(body: str, theme: str = '', *, images: list[str] | None = None) -> str:
    theme = theme or DEFAULT_THEME
    if theme not in THEMES:
        raise ValueError('未知公众号排版主题')
    ink, accent, tint, heading_font = THEMES[theme]
    converter = import_module('skills.builtin.skill-wechat-publisher.scripts.html_converter')
    styles, highlights, _, list_style = converter.load_theme(theme_name=theme)
    styles.update({
        'body': f'font-size:16px;line-height:1.85;color:{ink};margin:0;',
        'p': f'margin:0 0 17px;line-height:1.85;color:{ink};text-align:left;',
        'h1': f'margin:23px 0 12px;font:700 22px/1.4 {heading_font};color:{ink};',
        'h2': f'margin:28px 0 11px;font:700 19px/1.45 {heading_font};color:{accent};',
        'h3': f'margin:21px 0 9px;font-size:17px;line-height:1.5;color:{accent};',
        'blockquote': f'margin:20px 0;padding:11px 15px;border-left:2px solid {accent};background:{tint};color:{ink};',
        'strong': f'font-weight:700;color:{ink};',
    })
    if theme == 'refined-blue':
        styles['h2'] += f'padding-left:10px;border-left:3px solid {accent};'
    if theme == 'warm-editorial':
        styles['blockquote'] = (f'margin:25px 0;padding:12px 6px;text-align:center;'
                                f'border-block:1px solid #dccab4;font-family:{heading_font};color:{accent};')
    article = converter.convert_markdown_to_wechat_html(body, styles, highlights, '', list_style)
    article = re.sub(r'<img\b[^>]*>', '', article)
    article = re.sub(r'<a\b[^>]*>', '<a>', article)
    if images:
        embedded = '\n'.join(f'<p><img src="{html.escape(path, quote=True)}" style="max-width:100%;height:auto;"/></p>'
                             for path in images)
        article = article.removesuffix('</section>') + embedded + '\n</section>'
    return article
