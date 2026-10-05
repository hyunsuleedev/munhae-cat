import { strToU8, zipSync } from "fflate";
import type { TranslationOutline } from "./translation-export.ts";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
// A4 with 25.4 mm margins, in twentieths of a point.
const PAGE = { width: 11906, height: 16838, margin: 1440 };
const COLUMN = (PAGE.width - PAGE.margin * 2) / 2;

/** XML 1.0 cannot carry most C0 controls; drop them rather than emit an unreadable part. */
function xml(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function lines(text: string): string[] {
  return text.split(/\r\n?|\n/).map(line => line.trim()).filter(Boolean);
}

function paragraph(text: string, style?: string): string {
  const properties = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : "";
  return `<w:p>${properties}<w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
}

function cell(text: string, style?: string): string {
  // Every table cell must end with a paragraph, even when empty.
  const body = lines(text).map(line => paragraph(line, style)).join("") || "<w:p/>";
  return `<w:tc><w:tcPr><w:tcW w:w="${COLUMN}" w:type="dxa"/></w:tcPr>${body}</w:tc>`;
}

function body(outline: TranslationOutline): string {
  return outline.blocks.map(block => {
    if (block.kind === "heading") return paragraph(block.text, block.level === 0 ? "Title" : `Heading${Math.min(block.level, 6)}`);
    if (block.kind === "text") return lines(block.text).map(line => paragraph(line)).join("");
    const rows = block.rows.map(row => `<w:tr>${cell(row.source, "SourceText")}${cell(row.translation)}</w:tr>`).join("");
    return `<w:tbl><w:tblPr><w:tblStyle w:val="BilingualTable"/><w:tblW w:w="5000" w:type="pct"/><w:tblLayout w:type="fixed"/><w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr><w:tblGrid><w:gridCol w:w="${COLUMN}"/><w:gridCol w:w="${COLUMN}"/></w:tblGrid>${rows}</w:tbl><w:p/>`;
  }).join("");
}

function heading(level: number): string {
  const size = [32, 28, 26, 24, 22, 22][level - 1]!;
  return `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${level === 1 ? 480 : 360}" w:after="200"/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
}

function styles(lang: string): string {
  const tag = xml(lang === "ko" ? "ko-KR" : lang);
  const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFB9AC"/>`;
  return `${XML}<w:styles xmlns:w="${W}">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Batang" w:cs="Times New Roman"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="${tag}" w:eastAsia="ko-KR" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:wordWrap w:val="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="10"/><w:qFormat/><w:pPr><w:spacing w:after="480"/></w:pPr><w:rPr><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:style>
${[1, 2, 3, 4, 5, 6].map(heading).join("\n")}
<w:style w:type="paragraph" w:customStyle="1" w:styleId="SourceText"><w:name w:val="원문"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:wordWrap w:val="1"/><w:spacing w:after="120"/></w:pPr><w:rPr><w:sz w:val="23"/><w:szCs w:val="23"/><w:lang w:eastAsia="ko-KR"/></w:rPr></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
<w:style w:type="table" w:customStyle="1" w:styleId="BilingualTable"><w:name w:val="대역 표"/><w:basedOn w:val="TableNormal"/><w:tblPr><w:tblBorders>${border("top")}${border("bottom")}${border("insideH")}${border("insideV")}</w:tblBorders><w:tblCellMar><w:top w:w="140" w:type="dxa"/><w:left w:w="160" w:type="dxa"/><w:bottom w:w="140" w:type="dxa"/><w:right w:w="160" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;
}

const FOOTER = `${XML}<w:ftr xmlns:w="${W}"><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`;

export function renderTranslationDocx(outline: TranslationOutline): Uint8Array {
  const created = outline.generatedAt.replace(/\.\d+Z$/, "Z");
  const files: Record<string, string> = {
    "[Content_Types].xml": `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
    "_rels/.rels": `${XML}<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${R}/extended-properties" Target="docProps/app.xml"/></Relationships>`,
    "docProps/core.xml": `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(outline.title)}</dc:title><dc:language>${xml(outline.lang)}</dc:language><dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified></cp:coreProperties>`,
    "docProps/app.xml": `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Munhae</Application></Properties>`,
    "word/_rels/document.xml.rels": `${XML}<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${R}/settings" Target="settings.xml"/><Relationship Id="rId3" Type="${R}/footer" Target="footer1.xml"/></Relationships>`,
    "word/settings.xml": `${XML}<w:settings xmlns:w="${W}"><w:defaultTabStop w:val="800"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`,
    "word/styles.xml": styles(outline.lang),
    "word/footer1.xml": FOOTER,
    "word/document.xml": `${XML}<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body(outline)}<w:sectPr><w:footerReference w:type="default" r:id="rId3"/><w:pgSz w:w="${PAGE.width}" w:h="${PAGE.height}"/><w:pgMar w:top="${PAGE.margin}" w:right="${PAGE.margin}" w:bottom="${PAGE.margin}" w:left="${PAGE.margin}" w:header="851" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  };
  // Zip timestamps would make identical exports differ byte-for-byte.
  const mtime = new Date(created);
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, [strToU8(content), { mtime }]])), { level: 6 });
}
