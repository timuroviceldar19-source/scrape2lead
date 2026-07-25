import json
import os
import sys
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak

source, target = sys.argv[1], sys.argv[2]
with open(source, "r", encoding="utf-8") as handle:
    records = json.load(handle)

font_candidates = [r"C:\Windows\Fonts\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]
font_path = next((p for p in font_candidates if os.path.exists(p)), None)
font_name = "Helvetica"
if font_path:
    pdfmetrics.registerFont(TTFont("KgdUnicode", font_path))
    font_name = "KgdUnicode"

styles = getSampleStyleSheet()
normal = ParagraphStyle("KgdNormal", parent=styles["Normal"], fontName=font_name, fontSize=8.5, leading=11)
title = ParagraphStyle("KgdTitle", parent=normal, fontSize=16, leading=20, alignment=TA_CENTER, spaceAfter=8)
heading = ParagraphStyle("KgdHeading", parent=normal, fontSize=12, leading=15, spaceAfter=5)
doc = SimpleDocTemplate(target, pagesize=A4, rightMargin=14*mm, leftMargin=14*mm, topMargin=14*mm, bottomMargin=14*mm, title="Риски контрагентов КГД")
story = [Paragraph("Отчёт по рискам контрагентов КГД", title)]
counts = {color: sum(1 for r in records if r.get("color") == color) for color in ["red", "gray", "yellow", "green"]}
story += [Table([["Красный", "Серый", "Жёлтый", "Зелёный"], [counts["red"], counts["gray"], counts["yellow"], counts["green"]]], colWidths=[38*mm]*4, style=TableStyle([("FONTNAME", (0,0), (-1,-1), font_name), ("GRID", (0,0), (-1,-1), .4, colors.grey), ("BACKGROUND", (0,0), (0,-1), colors.HexColor("#FFC7CE")), ("BACKGROUND", (1,0), (1,-1), colors.HexColor("#D9E1F2")), ("BACKGROUND", (2,0), (2,-1), colors.HexColor("#FFEB9C")), ("BACKGROUND", (3,0), (3,-1), colors.HexColor("#C6EFCE")), ("ALIGN", (0,0), (-1,-1), "CENTER")]))]
story += [Spacer(1, 8), Paragraph("Дисклеймер: отчёт носит информационный характер и не заменяет официальную выписку или юридическое заключение.", normal), PageBreak()]

labels = {"red": "КРАСНЫЙ", "gray": "СЕРЫЙ", "yellow": "ЖЁЛТЫЙ", "green": "ЗЕЛЁНЫЙ"}
for index, r in enumerate(records):
    story.append(Paragraph(f'{r.get("name") or "Без наименования"} — БИН {r.get("bin", "")}', heading))
    bulk = r.get("bulkChecks", [])
    rows = [
        ["Итог", labels.get(r.get("color"), "СЕРЫЙ")], ["НДС", str(r.get("vat", {}).get("status", "н/д"))],
        ["Банкротство", "Да" if r.get("bankruptcy") else "Нет"], ["Ликвидация", "Да" if r.get("liquidation", {}).get("active") else "Нет"],
        ["Ограничение ЭСФ", "Да" if r.get("esfRestricted") else "Нет"], ["Неблагонадёжность", "; ".join(r.get("unreliableReasons", [])) or "Нет"],
        ["Bulk-списки", "; ".join(f'{b.get("source")}: {b.get("status")}, дата {b.get("listDate", "н/д")}' for b in bulk)],
        ["Пояснения", "; ".join(r.get("explanations", []))], ["Проверено", r.get("checkedAt", "")],
        ["Ссылки", "<br/>".join(r.get("links", []) + [b.get("sourceUrl", "") for b in bulk])]
    ]
    table = Table([[Paragraph(str(a), normal), Paragraph(str(b), normal)] for a,b in rows], colWidths=[42*mm, 126*mm], repeatRows=0)
    table.setStyle(TableStyle([("FONTNAME", (0,0), (-1,-1), font_name), ("GRID", (0,0), (-1,-1), .35, colors.grey), ("BACKGROUND", (0,0), (0,-1), colors.HexColor("#EAF2F8")), ("VALIGN", (0,0), (-1,-1), "TOP"), ("LEFTPADDING", (0,0), (-1,-1), 5), ("RIGHTPADDING", (0,0), (-1,-1), 5)]))
    story.append(table)
    if index < len(records)-1: story.append(PageBreak())

doc.build(story)
