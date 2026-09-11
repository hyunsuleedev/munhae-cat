import type { GlossaryEntryView, KnowledgeView, MunhaeApi } from "../../shared/munhae-api";
import { USAGE_LABELS } from "./knowledge-model";
import "../styles/quick-term.css";

type QuickTermDeps = {
  api: MunhaeApi;
  escape(value: unknown): string;
  notify(message: string, title?: string): void;
  getKnowledge(): KnowledgeView | null;
  onSaved(entry: GlossaryEntryView): void;
};

export function configureQuickTerm(deps: QuickTermDeps) {
  const dialog = document.createElement("dialog");
  dialog.id = "dlgQuickTerm";
  dialog.className = "quick-term-dialog";
  dialog.setAttribute("aria-labelledby", "quickTermTitle");
  dialog.setAttribute("aria-describedby", "quickTermScope");
  dialog.innerHTML = `<form id="quickTermForm">
    <div class="quick-term-heading"><p class="muted">프로젝트 공통 용어집</p><h2 id="quickTermTitle">용어 등록</h2></div>
    <p class="quick-term-help" id="quickTermScope">이 프로젝트에서 참고할 표현을 직접 등록합니다. 이 구절에만 해당하는 해석은 코멘트나 문서 문맥에 남겨 주세요.</p>
    <p id="quickTermDraftNotice" class="quick-term-notice" role="status" hidden></p>
    <fieldset id="quickTermFields" class="quick-term-fields">
      <div class="quick-term-pair">
        <div class="field"><label for="quickTermSource">원문 표현</label><input id="quickTermSource" class="input hanmun" required maxlength="500" placeholder="예: 太守" spellcheck="false" autocomplete="off"></div>
        <div class="field"><label for="quickTermTarget">번역 표현</label><input id="quickTermTarget" class="input" required maxlength="500" placeholder="예: 태수" autocomplete="off"></div>
      </div>
      <div class="field"><label for="quickTermUsage">사용 기준</label><select id="quickTermUsage" class="select" aria-describedby="quickTermUsageHelp">
        <option value="allowed">허용 · 문맥에 따라 사용</option><option value="preferred">기본 · 우선 참고할 표현</option><option value="forbidden">지양 · 피할 표현</option>
      </select><p id="quickTermUsageHelp" class="quick-term-help"></p></div>
      <div class="field"><label for="quickTermNote">뜻·근거·주의점 <span class="muted">(선택)</span></label><textarea id="quickTermNote" class="textarea" rows="5" maxlength="20000" placeholder="적용할 문맥, 아직 불확실한 점, 참고한 문헌이나 링크를 자유롭게 적어 주세요."></textarea></div>
    </fieldset>
    <p id="quickTermExisting" class="quick-term-notice" hidden></p>
    <p id="quickTermError" class="quick-term-error" role="alert" hidden></p>
    <div class="quick-term-footer"><button type="button" class="btn btn-sm" id="quickTermReset">입력 비우기</button><span class="sp"></span><button type="button" class="btn" id="quickTermClose">닫기</button><button type="submit" class="btn btn-primary" id="quickTermSave">용어집에 저장</button></div>
  </form>`;
  document.body.append(dialog);
  const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const value = dialog.querySelector<T>(`#${id}`);
    if (!value) throw new Error(`missing ${id}`);
    return value;
  };
  const source = el<HTMLInputElement>("quickTermSource");
  const target = el<HTMLInputElement>("quickTermTarget");
  const usage = el<HTMLSelectElement>("quickTermUsage");
  const note = el<HTMLTextAreaElement>("quickTermNote");
  let busy = false;
  let serial = 0;
  let baseline = "";
  let nextSource = "";
  let nextPrefill: { targetTerm: string; noteMd: string } | undefined;
  let importedDraft = false;
  let known: KnowledgeView | null = null;

  const snapshot = () => JSON.stringify([source.value, target.value, usage.value, note.value]);
  const hasDraft = () => importedDraft || baseline !== "" && snapshot() !== baseline;
  function message(id: string, text: string): void {
    const node = el(id);
    node.textContent = text;
    node.hidden = !text;
  }
  function currentTerms(): GlossaryEntryView[] {
    return (known ?? deps.getKnowledge())?.glossary.filter(entry => entry.targetLocale === "ko" && entry.sourceTerm === source.value.trim()) ?? [];
  }
  function updateHints(): void {
    el("quickTermUsageHelp").textContent = usage.value === "preferred"
      ? "이 원문 표현의 기본 대응어로 참고합니다. 기본 표현은 원문 표현마다 하나만 등록할 수 있습니다."
      : usage.value === "forbidden"
        ? "위 번역 표현을 사용하지 않도록 참고합니다. 피해야 하는 이유를 메모에 적어 주세요."
        : "가능한 번역 표현으로 참고합니다. 실제 문맥에 맞는지는 번역하면서 판단합니다.";
    const entries = currentTerms();
    const summary = entries.slice(0, 4).map(entry => `${entry.targetTerm} (${USAGE_LABELS[entry.usageStatus]})`).join(" · ");
    message("quickTermExisting", entries.length ? `이미 등록된 번역 표현: ${summary}${entries.length > 4 ? ` 외 ${entries.length - 4}개` : ""}. 수정은 공통 지식의 용어집에서 할 수 있습니다.` : "");
  }
  function setBusy(value: boolean): void {
    busy = value;
    el<HTMLFieldSetElement>("quickTermFields").disabled = value;
    for (const id of ["quickTermSave", "quickTermClose", "quickTermReset"]) el<HTMLButtonElement>(id).disabled = value;
    el<HTMLButtonElement>("quickTermSave").textContent = value ? "저장 중…" : "용어집에 저장";
    dialog.setAttribute("aria-busy", String(value));
  }
  function reset(value: string, prefill?: { targetTerm: string; noteMd: string }): void {
    importedDraft = !!prefill;
    source.value = value;
    target.value = prefill?.targetTerm ?? "";
    usage.value = "allowed";
    note.value = prefill?.noteMd ?? "";
    baseline = snapshot();
    message("quickTermError", "");
    message("quickTermDraftNotice", "");
    updateHints();
  }
  function duplicateMessage(entries: GlossaryEntryView[], src: string, tgt: string): string {
    if (entries.some(entry => entry.targetLocale === "ko" && entry.sourceTerm === src && entry.targetTerm === tgt)) {
      return "같은 원문·번역 표현이 이미 등록되어 있습니다. 기존 항목의 메모나 사용 기준은 공통 지식의 용어집에서 수정해 주세요.";
    }
    const preferred = entries.find(entry => entry.targetLocale === "ko" && entry.sourceTerm === src && entry.usageStatus === "preferred");
    if (usage.value === "preferred" && preferred) {
      return `‘${preferred.targetTerm}’이 이미 기본 번역 표현입니다. 새 표현을 ‘허용’으로 등록하거나, 공통 지식의 용어집에서 기존 기준을 변경해 주세요.`;
    }
    return "";
  }
  async function save(): Promise<void> {
    if (busy || !dialog.open) return;
    const src = source.value.trim();
    const tgt = target.value.trim();
    const memo = note.value.trim();
    if (!src || !tgt) {
      message("quickTermError", "원문 표현과 번역 표현을 모두 입력해 주세요.");
      (!src ? source : target).focus();
      return;
    }
    if (src.length > 500 || tgt.length > 500 || memo.length > 20_000) {
      message("quickTermError", "입력 한도를 초과했습니다. 원문·번역 표현 또는 메모를 줄여 주세요.");
      return;
    }
    const current = ++serial;
    setBusy(true);
    message("quickTermError", "");
    try {
      // Read the latest list before creating. This dialog never supplies an id or overwrites an entry.
      const latest = await deps.api.knowledge.get();
      if (current !== serial || !dialog.open) return;
      if (!latest.ok) throw new Error("기존 용어집을 확인하지 못했습니다. 입력은 유지됩니다. 다시 저장해 주세요.");
      known = latest.data;
      updateHints();
      const duplicate = duplicateMessage(known.glossary, src, tgt);
      if (duplicate) { message("quickTermError", duplicate); return; }
      const result = await deps.api.knowledge.upsertGlossary({
        sourceTerm: src,
        targetTerm: tgt,
        targetLocale: "ko",
        termKind: "general",
        reading: null,
        noteMd: memo || null,
        usageStatus: usage.value === "preferred" ? "preferred" : usage.value === "forbidden" ? "forbidden" : "allowed",
      });
      if (current !== serial || !dialog.open) return;
      if (!result.ok) {
        throw new Error(result.error.code === "project_locked"
          ? "프로젝트를 수정할 수 없습니다. 편집 가능한 프로젝트에서 다시 저장해 주세요."
          : "용어를 저장하지 못했습니다. 기존 기본 표현이나 프로젝트 상태를 확인한 뒤 다시 시도해 주세요. 입력은 유지됩니다.");
      }
      known = { ...known, glossary: [result.data, ...known.glossary] };
      reset("");
      setBusy(false);
      dialog.close();
      try { deps.onSaved(result.data); }
      catch { /* The entry is already saved. A view refresh must not suggest saving it twice. */ }
      deps.notify(`‘${src} → ${tgt}’을 프로젝트 용어집에 저장했습니다.`, "용어 등록");
    } catch (cause) {
      if (current === serial && dialog.open) message("quickTermError", cause instanceof Error ? cause.message : "저장하지 못했습니다. 입력은 유지됩니다. 다시 시도해 주세요.");
    } finally {
      if (current === serial) setBusy(false);
    }
  }

  el<HTMLFormElement>("quickTermForm").addEventListener("submit", event => { event.preventDefault(); void save(); });
  source.addEventListener("input", updateHints);
  usage.addEventListener("change", updateHints);
  el("quickTermClose").addEventListener("click", () => { if (!busy) dialog.close(); });
  el("quickTermReset").addEventListener("click", () => { if (!busy) { reset(nextSource, nextPrefill); (nextSource ? target : source).focus(); } });
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  dialog.addEventListener("close", () => { if (!dialog.open) { ++serial; setBusy(false); } });

  return {
    open(sourceTerm = "", prefill?: { targetTerm: string; noteMd: string }): void {
      if (busy) return;
      ++serial;
      known = deps.getKnowledge();
      nextSource = sourceTerm.trim();
      nextPrefill = prefill;
      el("quickTermReset").textContent = prefill ? "새 사전 뜻으로 작성" : "입력 비우기";
      const preserve = hasDraft();
      if (!preserve) reset(nextSource, nextPrefill);
      else {
        updateHints();
        message("quickTermDraftNotice", `저장하지 않은 용어를 이어서 작성합니다. 새로 작성하려면 ‘${prefill ? "새 사전 뜻으로 작성" : "입력 비우기"}’ 버튼을 누르세요.`);
      }
      message("quickTermError", "");
      if (!dialog.open) dialog.showModal();
      (source.value ? target : source).focus();
    },
  };
}
