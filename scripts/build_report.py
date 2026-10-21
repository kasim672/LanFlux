"""Build the repository PDF from its maintained Markdown guides (ReportLab only).

Run from any directory: python scripts/build_report.py
Optional dependency: python -m pip install -r requirements-report.txt
"""
from __future__ import annotations

import argparse
from datetime import date
from html import escape
from pathlib import Path
import re
import textwrap

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    CondPageBreak, Flowable, Image, KeepTogether, PageBreak, Paragraph, SimpleDocTemplate,
    Spacer, Table, TableStyle,
)
from reportlab.platypus.tableofcontents import TableOfContents

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / 'docs'
CHAPTERS = [
    ('REPORT.md', 'Project overview and report guide'),
    ('USER_GUIDE.md', 'Installation and user guide'),
    ('ARCHITECTURE.md', 'Architecture and transfer protocol'),
    ('AI_MONITOR.md', 'Machine learning and transfer intelligence'),
    ('SECURITY.md', 'Security and privacy'),
    ('CONFIGURATION.md', 'Configuration reference'),
    ('DEPLOYMENT.md', 'HTTPS, TURN and public deployment'),
    ('NETWORK_EXPERIMENTS.md', 'Reproducible network experiments'),
    ('VERIFICATION.md', 'Verification evidence and limitations'),
    ('FONT_NOTICES.md', 'PDF font copyright and permission notice'),
]
NAVY = colors.HexColor('#142c35')
GREEN = colors.HexColor('#18735c')
MUTED = colors.HexColor('#52636e')
PALE = colors.HexColor('#eef5f3')
WIDTH = A4[0] - 88


def plain(value):
    replacements = {'→': '->', '↔': '<->', '←': '<-', '–': '-', '—': ' - ',
                    '×': 'x', '÷': '/', '≤': '<=', '≥': '>=', '−': '-',
                    '“': '"', '”': '"', '‘': "'", '’': "'", '…': '...',
                    '\u00a0': ' ', '\u202f': ' ', '↑': 'up', '↓': 'down'}
    for a, b in replacements.items():
        value = value.replace(a, b)
    return value


def inline(value, source):
    """Escape source first; permit only our own limited formatting/link markup."""
    value = escape(plain(value))
    def link(match):
        label, destination = match.groups()
        if not re.match(r'^https?://', destination):
            destination = 'https://github.com/kasim672/LanFlux/blob/main/' + str(
                (source.parent / destination.split('#', 1)[0]).resolve().relative_to(ROOT))
        return f'<link href="{escape(destination, quote=True)}" color="#18735c">{label}</link>'
    value = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', link, value)
    value = re.sub(r'`([^`]+)`', r'<font name="Courier" size="8">\1</font>', value)
    value = re.sub(r'\*\*([^*]+)\*\*', r'<b>\1</b>', value)
    return value


class NetworkDiagram(Flowable):
    """Native vector overview: no screenshot or invented measurement."""
    def __init__(self, deployment=False):
        super().__init__()
        self.width, self.height = WIDTH, 188
        self.deployment = deployment

    def draw(self):
        c = self.canv
        w = self.width
        def box(x, y, bw, label, detail):
            c.setFillColor(PALE); c.setStrokeColor(colors.HexColor('#b8d5cb'))
            c.roundRect(x, y, bw, 43, 7, stroke=1, fill=1)
            c.setFillColor(NAVY); c.setFont('ReportBold', 9)
            c.drawCentredString(x + bw / 2, y + 26, label)
            c.setFont('Report', 7); c.setFillColor(MUTED)
            c.drawCentredString(x + bw / 2, y + 12, detail)
        def line(x1, y1, x2, y2, label='', label_y=None):
            c.setStrokeColor(GREEN); c.setLineWidth(1.2); c.line(x1, y1, x2, y2)
            if label:
                c.setFont('Report', 7); c.setFillColor(MUTED)
                c.drawCentredString((x1+x2)/2, label_y if label_y is not None else (y1+y2)/2+5, label)
        box(0, 125, 112, 'Browser A', 'Files stay in browser')
        box(w-112, 125, 112, 'Browser B', 'Approval + verification')
        box(w/2-73, 52, 146, 'HTTPS / WSS + FastAPI' if self.deployment else 'Python / FastAPI',
            'Private upstream / one worker' if self.deployment else 'Rooms + signaling + ML')
        line(112, 146, w-112, 146, 'Encrypted WebRTC DataChannel', 157)
        line(56, 125, w/2-73, 74)
        line(w-56, 125, w/2+73, 74)
        c.setFont('Report', 7); c.setFillColor(MUTED)
        c.drawString(16, 91, 'Signaling + network metadata')
        c.drawRightString(w-16, 91, 'Signaling + network metadata')
        box(w/2-73, 0, 146, 'External TURN (optional)',
            'Separate public IP / TLS 443' if self.deployment else 'Relays encrypted WebRTC')
        c.setDash(3, 3)
        line(0, 146, 0, 21); line(0, 21, w/2-73, 21)
        line(w, 146, w, 21); line(w, 21, w/2+73, 21)
        c.setDash()


class MobileDetail(Flowable):
    """Clip the top of a real tall screenshot to a readable PDF viewport."""
    def __init__(self, path):
        super().__init__()
        self.path = path
        self.width, self.height = 190, 330
        self.image = Image(str(path))

    def draw(self):
        c = self.canv
        c.saveState()
        clip = c.beginPath(); clip.rect(0, 0, self.width, self.height)
        c.clipPath(clip, stroke=0)
        scaled_height = self.image.imageHeight * self.width / self.image.imageWidth
        c.drawImage(str(self.path), 0, self.height-scaled_height,
                    width=self.width, height=scaled_height)
        c.restoreState()


class Report(SimpleDocTemplate):
    def afterFlowable(self, flowable):
        if isinstance(flowable, Paragraph) and getattr(flowable, 'report_chapter', None):
            title = flowable.report_chapter
            key = f'chapter-{self.seq.nextf("chapter")}'
            self.canv.bookmarkPage(key)
            self.canv.addOutlineEntry(title, key, 0, False)
            self.notify('TOCEntry', (0, title, self.page, key))


def build(output, edition):
    # ReportLab ships Bitstream Vera: portable builds without system fonts.
    import reportlab
    font_dir = Path(reportlab.__file__).resolve().parent / 'fonts'
    for name, file in [('Report', 'Vera.ttf'), ('ReportBold', 'VeraBd.ttf'),
                       ('ReportItalic', 'VeraIt.ttf'), ('ReportBoldItalic', 'VeraBI.ttf')]:
        pdfmetrics.registerFont(TTFont(name, str(font_dir / file)))
    pdfmetrics.registerFontFamily('Report', normal='Report', bold='ReportBold',
                                  italic='ReportItalic', boldItalic='ReportBoldItalic')
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle('BodyReport', fontName='Report', fontSize=9,
                             leading=13, textColor=NAVY, spaceAfter=7))
    styles.add(ParagraphStyle('Chapter', fontName='ReportBold', fontSize=21,
                             leading=27, textColor=NAVY, spaceAfter=18))
    styles.add(ParagraphStyle('SectionReport', fontName='ReportBold', fontSize=12,
                             leading=16, textColor=GREEN, spaceBefore=14, spaceAfter=7,
                             keepWithNext=True))
    styles.add(ParagraphStyle('SmallHeading', parent=styles['SectionReport'], fontSize=10, leading=14))
    styles.add(ParagraphStyle('CellReport', parent=styles['BodyReport'], fontSize=7.8, leading=11, spaceAfter=0))
    styles.add(ParagraphStyle('CaptionReport', parent=styles['BodyReport'], fontSize=7.5,
                             leading=11, textColor=MUTED, spaceAfter=12))
    styles.add(ParagraphStyle('CodeReport', fontName='Courier', fontSize=7.3, leading=10,
                             textColor=NAVY, spaceAfter=0))
    styles.add(ParagraphStyle('CoverTitle', fontName='ReportBold', fontSize=44, leading=52,
                             textColor=NAVY, spaceAfter=14))
    styles.add(ParagraphStyle('CoverSub', fontName='Report', fontSize=17, leading=24,
                             textColor=GREEN, spaceAfter=14))
    styles.add(ParagraphStyle('TOCReport', parent=styles['BodyReport'], fontSize=11, leading=19,
                             spaceBefore=5, leftIndent=0, rightIndent=24))
    p = lambda text, name='BodyReport': Paragraph(text, styles[name])
    def table(rows, header=True, widths=None):
        cells = [[p(cell, 'CellReport') for cell in row] for row in rows]
        n = len(rows[0])
        widths = widths or ([WIDTH*.30, WIDTH*.70] if n == 2 else [WIDTH/n]*n)
        result = Table(cells, colWidths=widths, repeatRows=1 if header else 0, hAlign='LEFT')
        commands = [('VALIGN', (0,0), (-1,-1), 'TOP'), ('LEFTPADDING',(0,0),(-1,-1),8),
                    ('RIGHTPADDING',(0,0),(-1,-1),8), ('TOPPADDING',(0,0),(-1,-1),7),
                    ('BOTTOMPADDING',(0,0),(-1,-1),7), ('LINEBELOW',(0,0),(-1,-1),.35,colors.HexColor('#dce6e3'))]
        if header:
            commands += [('BACKGROUND',(0,0),(-1,0),PALE)]
        result.setStyle(TableStyle(commands))
        return [result, Spacer(1,9)]

    def markdown(source):
        lines = source.read_text(encoding='utf-8').splitlines()
        story = []; i = 0
        while i < len(lines):
            line = lines[i].strip(); i += 1
            if not line or line == '---':
                continue
            if line.startswith('# '):  # Chapter title is inserted by the builder.
                continue
            if line.startswith('```'):
                language = line[3:]; block = []
                while i < len(lines) and not lines[i].lstrip().startswith('```'):
                    block.append(lines[i]); i += 1
                i += 1
                if language == 'mermaid':
                    if any('flowchart' in item for item in block):
                        story += [NetworkDiagram(source.name == 'DEPLOYMENT.md'), Spacer(1,12)]
                    else:
                        # Accessible tabular sequence alongside vector data-path diagrams.
                        aliases = {}; rows = [['From', 'To', 'Message / step']]
                        for item in block:
                            item = item.strip()
                            participant = re.match(r'participant (\w+) as (.+)', item)
                            if participant:
                                aliases[participant[1]] = participant[2]
                            arrow = re.match(r'(\w+)-[-<>]*>>(\w+):\s*(.+)', item)
                            if arrow:
                                rows.append([escape(aliases.get(arrow[1], arrow[1])),
                                             escape(aliases.get(arrow[2], arrow[2])), escape(plain(arrow[3]))])
                            elif re.match(r'^(alt|else|loop)\s+', item):
                                rows.append(['', '', '<i>'+escape(plain(item))+'</i>'])
                        story += table(rows, widths=[WIDTH*.21, WIDTH*.21, WIDTH*.58])
                else:
                    wrapped = []
                    for item in block:
                        wrapped.extend(textwrap.wrap(plain(item), width=101, replace_whitespace=False,
                                                     drop_whitespace=False) or [' '])
                    code = '<br/>'.join(escape(item).replace(' ', '&#160;') for item in wrapped)
                    box = Table([[p(code, 'CodeReport')]], colWidths=[WIDTH])
                    box.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),PALE),
                                             ('BOX',(0,0),(-1,-1),.4,colors.HexColor('#c6dcd3')),
                                             ('LEFTPADDING',(0,0),(-1,-1),10),
                                             ('TOPPADDING',(0,0),(-1,-1),9),('BOTTOMPADDING',(0,0),(-1,-1),9)]))
                    story += [box, Spacer(1,10)]
                continue
            image = re.fullmatch(r'!\[([^\]]*)\]\(([^)]+)\)', line)
            if image:
                path = (source.parent / image[2]).resolve()
                if not path.is_relative_to(ROOT):
                    raise ValueError('Report image must be inside repository.')
                item = Image(str(path))
                if item.imageHeight / item.imageWidth > 3:
                    item = MobileDetail(path)
                    image_caption = image[1] + ' (top-of-page detail; full image in repository)'
                else:
                    scale = min(WIDTH/item.imageWidth, 330/item.imageHeight)
                    item.drawWidth, item.drawHeight = item.imageWidth*scale, item.imageHeight*scale
                    image_caption = image[1]
                story.append(KeepTogether([item, Spacer(1,5), p(escape(plain(image_caption)), 'CaptionReport')]))
                continue
            heading = re.match(r'^(#{2,6})\s+(.+)', line)
            if heading:
                following = next((v.strip() for v in lines[i:] if v.strip()), '')
                if following.startswith('!['):
                    story.append(CondPageBreak(390))
                story.append(p(inline(heading[2], source), 'SectionReport' if len(heading[1])==2 else 'SmallHeading'))
                continue
            if line.startswith('|'):
                rows = []
                while True:
                    if not re.match(r'^\|\s*:?-', line):
                        rows.append([inline(cell.strip(), source) for cell in line.strip('|').split('|')])
                    if i >= len(lines) or not lines[i].strip().startswith('|'):
                        break
                    line = lines[i].strip(); i += 1
                story += table(rows)
                continue
            bullet = re.match(r'^([-*]|\d+\.)\s+(.+)', line)
            if bullet:
                marker = '-' if bullet[1] in '-*' else bullet[1]
                story.append(p(f'<b>{marker}</b> '+inline(bullet[2],source)))
                continue
            paragraph = [line]
            while i < len(lines) and lines[i].strip() and not re.match(r'^(#|\||```|!\[|[-*] |\d+\. )', lines[i].strip()):
                paragraph.append(lines[i].strip()); i += 1
            story.append(p(inline(' '.join(paragraph),source)))
        return story

    def page(canvas, doc):
        canvas.saveState()
        if doc.page > 1:
            canvas.setStrokeColor(colors.HexColor('#dce6e3')); canvas.line(44, A4[1]-34, A4[0]-44, A4[1]-34)
            canvas.setFont('Report',7); canvas.setFillColor(MUTED)
            canvas.drawString(44,A4[1]-26,'LANFLUX / Technical report')
        canvas.setFont('Report',7); canvas.setFillColor(MUTED)
        canvas.drawString(44,24,f'Documentation edition {edition} | github.com/kasim672/LanFlux')
        canvas.drawRightString(A4[0]-44,24,str(doc.page))
        canvas.restoreState()

    story = [Spacer(1,40), p('LANFLUX','CoverTitle'), p('AI-powered peer-to-peer file sharing','CoverSub'),
             p('Technical report &amp; operating guide','Chapter'),
             p('Browser networking, file integrity, security, machine learning, deployment and reproducible evaluation.'),
             Spacer(1,18)]
    hero = Image(str(DOCS/'screenshots/homepage.png'))
    ratio = min(WIDTH / hero.imageWidth, 245 / hero.imageHeight)
    hero.drawWidth, hero.drawHeight = hero.imageWidth * ratio, hero.imageHeight * ratio
    story += [hero, Spacer(1,20), p(f'<b>Documentation edition:</b> {edition}'),
              p('<b>Scope:</b> Current implementation extending published version 0.3.0. '
                'Real browser evidence; no fabricated benchmark or accuracy claims.'),
              p('<b>Project:</b> <link href="https://github.com/kasim672/LanFlux" color="#18735c">github.com/kasim672/LanFlux</link>'),
              PageBreak(), p('Contents','Chapter')]
    toc = TableOfContents(); toc.levelStyles=[styles['TOCReport']]
    story += [toc, Spacer(1,25), p('Reading note','SectionReport'),
              p('Start with the user guide to run the application. Architecture explains the networking protocol; '
                'the AI chapter separates measured observations, model outputs and advisory rules. '
                'Security, deployment and verification state the operational boundaries explicitly.'), PageBreak()]
    for index, (file, title) in enumerate(CHAPTERS,1):
        if index > 1:
            story.append(PageBreak())
        heading = p(f'{index:02d} / {escape(title)}','Chapter'); heading.report_chapter=f'{index:02d} / {title}'
        story += [heading, p('Maintained source: docs/'+file,'CaptionReport'), *markdown(DOCS/file)]
    output.parent.mkdir(parents=True,exist_ok=True)
    doc = Report(str(output), pagesize=A4, rightMargin=44, leftMargin=44,
                 topMargin=49, bottomMargin=44,
                 title='LANFLUX - Technical Report', author='LANFLUX project',
                 subject='WebRTC file sharing, security, IsolationForest and RandomForest networking',
                 pageCompression=1)
    doc.multiBuild(story,onFirstPage=page,onLaterPages=page)
    print(f'Created {output.relative_to(ROOT) if output.is_relative_to(ROOT) else output} ({output.stat().st_size:,} bytes)')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,default=DOCS/'LANFLUX_Technical_Report.pdf')
    parser.add_argument('--date',default=date.today().isoformat(),help='Documentation edition, YYYY-MM-DD')
    args=parser.parse_args()
    date.fromisoformat(args.date)
    build(args.output.resolve(),args.date)
