import {
  COMMUNITY_CATEGORIES,
  COMMUNITY_CATEGORY_LABELS,
  COMMUNITY_WEB_URL,
  isCommunityCategory,
  parseCommunityTags,
  validateCommunityPost,
} from "../../shared/community";
import type {
  CommunityCategory,
  CommunityComment,
  CommunityFeed,
  CommunityMember,
  CommunityPost,
  CommunityPostInput,
  CommunityReport,
  DocumentListItem,
  HomeView,
  IpcResult,
} from "../../shared/munhae-api";
import { t, ui } from "./i18n";
import { bindSidebar, defaultSidebarTree, esc, go, initShell, must, notify, renderSidebar, setSidebarProject } from "./shared";

type Filter = "all" | "saved" | CommunityCategory;
type View =
  | { kind: "empty" }
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "error"; message: string }
  | { kind: "post"; post: CommunityPost; comments: CommunityComment[] }
  | { kind: "compose"; post: CommunityPost | null };

const shell = initShell({ page: "community", selfTitle: t("커뮤니티") });
const api = shell.api;
const dialog = must<HTMLDialogElement>("#dlgCommunity");

let docs: DocumentListItem[] = [];
let member: CommunityMember | null = null;
let posts: CommunityPost[] = [];
let bookmarks = new Set<string>();
let filter: Filter = "all";
let sort = "newest";
let query = "";
let view: View = { kind: "empty" };
let selectedId: string | null = new URLSearchParams(location.search).get("post");
let threadRequest = 0;
let loaded = false;

const tree = () => defaultSidebarTree(docs);
const message = (error: unknown) => t(error instanceof Error ? error.message : "커뮤니티 요청을 완료하지 못했습니다.");
const label = (category: CommunityCategory) => t(COMMUNITY_CATEGORY_LABELS[category]);
const fail = (error: unknown) => notify(message(error), t("커뮤니티"));

async function call<T>(request: Promise<IpcResult<T>>): Promise<T> {
  const result = await request;
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

/** One request per control; a second click while it runs does nothing. */
async function busy(button: HTMLButtonElement | null, action: () => Promise<void>): Promise<void> {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try { await action(); } catch (error) { fail(error); } finally { if (button?.isConnected) button.disabled = false; }
}

function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(document.documentElement.lang || "ko", { year: "numeric", month: "short", day: "numeric" }).format(date);
}

function syncUrl(): void {
  history.replaceState(null, "", selectedId ? `?post=${encodeURIComponent(selectedId)}` : location.pathname);
}

function visiblePosts(): CommunityPost[] {
  const q = query.trim().toLocaleLowerCase();
  return posts
    .filter(post => (filter === "all" || (filter === "saved" ? bookmarks.has(post.id) : post.category === filter))
      && (!q || [post.title, post.body, post.original, post.translation, post.prompt, post.source, post.authorName, ...post.tags]
        .join(" ").toLocaleLowerCase().includes(q)))
    .sort((a, b) => sort === "comments" ? b.commentCount - a.commentCount || b.createdAt.localeCompare(a.createdAt)
      : sort === "oldest" ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt));
}

function badges(post: CommunityPost): string {
  return `<span class="tag tag-plain">${esc(label(post.category))}</span>`
    + (post.resolved ? `<span class="tag tag-ok">${esc(t("해결됨"))}</span>` : "")
    + (post.private ? `<span class="tag tag-line">${esc(t("비공개"))}</span>` : "");
}

/** Placeholders shaped like the real rows and reading pane, so nothing jumps when data arrives. */
const bar = (width: string, kind = "") => `<span class="community-skeleton-bar${kind ? ` is-${kind}` : ""}" style="width:${width}"></span>`;

function listSkeleton(): string {
  return [["72%", "94%", "58%"], ["54%", "88%", "71%"], ["66%", "97%", "43%"], ["48%", "91%", "62%"], ["61%", "84%", "52%"]]
    .map(([title, first, second]) => `<div class="material-row community-row community-skeleton" aria-hidden="true">${bar("56px", "tag")}${bar(title!, "title")}${bar(first!)}${bar(second!)}${bar("34%", "meta")}</div>`)
    .join("");
}

function detailSkeleton(): string {
  return `<div class="community-skeleton" aria-hidden="true">${bar("64px", "tag")}${bar("68%", "heading")}${bar("30%", "meta")}${bar("96%", "body")}${bar("91%")}${bar("84%")}${bar("58%")}${bar("100%", "block")}</div>`;
}

function renderCategories(): void {
  const count = (key: Filter) => key === "all" ? posts.length
    : key === "saved" ? posts.filter(post => bookmarks.has(post.id)).length
      : posts.filter(post => post.category === key).length;
  const items: Array<[Filter, string]> = [["all", t("전체")], ...COMMUNITY_CATEGORIES.map((key): [Filter, string] => [key, label(key)]), ["saved", t("저장한 글")]];
  must("#categorySeg").innerHTML = items.map(([key, text]) =>
    `<button type="button" role="tab" data-filter="${key}" aria-selected="${filter === key}">${esc(text)}${loaded ? `<span class="cnt">${count(key)}</span>` : ""}</button>`).join("");
}

function renderList(): void {
  const list = must("#postList");
  list.removeAttribute("aria-busy");
  const items = visiblePosts();
  must("#communityCount").textContent = ui`글 ${items.length}개`;
  if (!items.length) {
    const empty = filter === "saved" ? t("글을 저장하면 이곳에 모아 둘 수 있습니다.")
      : query ? t("검색 결과가 없습니다. 다른 구절이나 짧은 검색어로 찾아보세요.") : t("아직 글이 없습니다. 작은 질문 하나로 대화를 시작해 보세요.");
    list.innerHTML = `<p class="empty">${esc(empty)}</p>`;
    return;
  }
  list.innerHTML = items.map(post => {
    const active = post.id === selectedId;
    return `<button type="button" class="material-row community-row${active ? " is-active" : ""}" data-post="${esc(post.id)}"${active ? ' aria-current="true"' : ""}>`
      + `<span class="community-row-tags">${badges(post)}</span>`
      + `<span class="community-row-title">${esc(post.title)}</span>`
      + `<span class="community-row-excerpt">${esc(post.body)}</span>`
      + `<span class="material-row-footer"><span>${esc(post.authorName)} · ${esc(when(post.createdAt))}</span>`
      + `<span>${bookmarks.has(post.id) ? `${esc(t("저장됨"))} · ` : ""}${esc(ui`의견 ${post.commentCount}`)}</span></span></button>`;
  }).join("");
}

function commentMarkup(comment: CommunityComment): string {
  const canDelete = member && (member.id === comment.authorId || member.isModerator);
  return `<article class="community-comment"><div class="community-comment-meta"><strong>${esc(comment.authorName)}</strong><span>${esc(when(comment.createdAt))}</span>`
    + (canDelete ? `<button class="btn btn-ghost btn-sm btn-danger" type="button" data-action="delete-comment" data-id="${esc(comment.id)}">${esc(t("삭제"))}</button>` : "")
    + `</div><p class="material-body">${esc(comment.body)}</p></article>`;
}

function postMarkup(post: CommunityPost, comments: CommunityComment[]): string {
  const own = member?.id === post.authorId;
  const manage = own || member?.isModerator === true;
  const saved = bookmarks.has(post.id);
  const section = (heading: string, body: string) => `<section class="material-section"><h3>${esc(heading)}</h3>${body}</section>`;
  const button = (action: string, text: string, extra = "") => `<button class="btn btn-sm${extra}" type="button" data-action="${action}">${esc(text)}</button>`;
  return `<div class="materials-detail-top community-row-tags">${badges(post)}</div>`
    + `<h2>${esc(post.title)}</h2>`
    + `<p class="community-meta">${esc(post.authorName)} · ${esc(when(post.createdAt))}${post.updatedAt !== post.createdAt ? ` · ${esc(t("수정됨"))}` : ""}</p>`
    + (post.private ? `<p class="material-condition">${esc(t("작성자와 운영자만 볼 수 있는 문의입니다."))}</p>` : "")
    + `<p class="material-body community-body">${esc(post.body)}</p>`
    + (post.original ? section(t("원문"), `<div class="material-quote">${esc(post.original)}</div>`) : "")
    + (post.translation ? section(t("번역 시안"), `<p class="material-body">${esc(post.translation)}</p>`) : "")
    + (post.source ? section(t("출처"), `<p class="material-body">${esc(post.source)}</p>`) : "")
    + (post.prompt ? `<section class="material-section"><h3 class="community-section-head">${esc(t("스킬·프롬프트"))}${button("copy-prompt", t("복사"))}</h3><pre class="community-prompt">${esc(post.prompt)}</pre></section>` : "")
    + (post.tags.length ? `<div class="community-tags">${post.tags.map(tag => `<button class="tag tag-line" type="button" data-tag="${esc(tag)}">#${esc(tag)}</button>`).join("")}</div>` : "")
    + `<div class="material-actions">`
    + `<button class="btn btn-sm" type="button" data-action="bookmark" aria-pressed="${saved}">${esc(saved ? t("저장 취소") : t("저장"))}</button>`
    + button("copy-link", t("웹 링크 복사"))
    + (manage ? "" : button("report", t("신고")))
    + (own && post.category === "question" ? button("resolve", post.resolved ? t("해결됨 취소") : t("해결됨으로 표시")) : "")
    + (own ? button("edit", t("수정")) : "")
    + (manage ? button("delete-post", t("삭제"), " btn-danger") : "")
    + `</div>`
    + `<section class="material-section community-comments"><h3>${esc(ui`의견 ${comments.length}`)}</h3>`
    + (comments.length ? comments.map(commentMarkup).join("") : `<p class="community-muted">${esc(t("첫 의견을 남겨 주세요. 다른 해석과 경험도 환영합니다."))}</p>`)
    + `<form id="commentForm" class="community-comment-form" novalidate>`
    + `<textarea class="textarea" name="body" rows="3" maxlength="5000" aria-label="${esc(t("의견"))}" placeholder="${esc(t("해석의 근거나 도움이 될 경험을 나눠 주세요."))}"></textarea>`
    + `<p class="community-error" role="alert"></p>`
    + `<div class="community-form-actions"><button class="btn btn-primary btn-sm" type="submit">${esc(t("의견 남기기"))}</button></div></form></section>`;
}

const draftKey = (id: string | null) => `munhae.community.draft:${member?.id ?? ""}:${id || "new"}`;

function readDraft(id: string | null): Partial<CommunityPostInput> {
  try { return JSON.parse(sessionStorage.getItem(draftKey(id)) || "{}") as Partial<CommunityPostInput>; } catch { return {}; }
}

function clearDraft(id: string | null): void {
  try { sessionStorage.removeItem(draftKey(id)); } catch { /* Drafts are a convenience only. */ }
}

function formInput(form: HTMLFormElement, keepHidden = false): CommunityPostInput {
  const values = new FormData(form);
  const category = String(values.get("category") ?? "");
  const kept = (name: string, visibleFor: string) => keepHidden || category === visibleFor ? String(values.get(name) ?? "").trim() : "";
  return {
    category: isCommunityCategory(category) ? category : "discussion",
    title: String(values.get("title") ?? "").trim(),
    body: String(values.get("body") ?? "").trim(),
    source: String(values.get("source") ?? "").trim(),
    original: kept("original", "discussion"),
    translation: kept("translation", "discussion"),
    prompt: kept("prompt", "resource"),
    tags: parseCommunityTags(String(values.get("tags") ?? "")),
    private: (keepHidden || category === "question") && (form.elements.namedItem("private") as HTMLInputElement).checked,
  };
}

function saveDraft(): void {
  const form = document.querySelector<HTMLFormElement>("#composeForm");
  if (!form) return;
  try { sessionStorage.setItem(draftKey(form.dataset.id || null), JSON.stringify(formInput(form, true))); } catch { /* Drafts are a convenience only. */ }
}

function composeMarkup(post: CommunityPost | null): string {
  const initial: CommunityPostInput = {
    category: isCommunityCategory(filter) ? filter : "discussion",
    title: "", body: "", source: "", original: "", translation: "", prompt: "", tags: [], private: false,
    ...(post ?? {}),
    ...readDraft(post?.id ?? null),
  };
  const optional = `<small>${esc(t("(선택)"))}</small>`;
  const area = (name: "original" | "translation" | "prompt", text: string, rows: number, className = "") =>
    `<div class="field"><label for="cf-${name}">${esc(text)} ${optional}</label><textarea class="textarea${className}" id="cf-${name}" name="${name}" rows="${rows}" maxlength="${name === "prompt" ? 30000 : 20000}">${esc(initial[name])}</textarea></div>`;
  return `<form id="composeForm" class="community-form" data-id="${esc(post?.id ?? "")}" data-was-private="${post?.private === true}" novalidate>`
    + `<div class="materials-detail-top">${esc(post ? t("글 수정") : t("새 글"))}</div>`
    + `<div class="community-field-row">`
    + `<div class="field"><label for="cf-category">${esc(t("글 유형"))}</label><select class="select" id="cf-category" name="category">${COMMUNITY_CATEGORIES.map(key => `<option value="${key}"${initial.category === key ? " selected" : ""}>${esc(label(key))}</option>`).join("")}</select></div>`
    + `<div class="field"><label for="cf-tags">${esc(t("태그"))} ${optional}</label><input class="input" id="cf-tags" name="tags" maxlength="124" placeholder="${esc(t("예: 표점, 시문 (최대 5개)"))}" value="${esc(initial.tags.join(", "))}"></div>`
    + `</div>`
    + `<div class="field"><label for="cf-title">${esc(t("제목"))}</label><input class="input" id="cf-title" name="title" maxlength="120" placeholder="${esc(t("이야기의 주제를 한 문장으로 적어 주세요"))}" value="${esc(initial.title)}"></div>`
    + `<div data-for="discussion">${area("original", t("원문"), 4, " hanmun")}${area("translation", t("번역 시안"), 4)}</div>`
    + `<div class="field"><label for="cf-body" id="cf-body-label"></label><textarea class="textarea" id="cf-body" name="body" rows="8" maxlength="20000">${esc(initial.body)}</textarea></div>`
    + `<div data-for="resource">${area("prompt", t("스킬·프롬프트 본문"), 8, " community-mono")}</div>`
    + `<div class="field"><label for="cf-source">${esc(t("출처"))} ${optional}</label><input class="input" id="cf-source" name="source" maxlength="2000" placeholder="${esc(t("문헌명, 권차, 편명 또는 원문 주소"))}" value="${esc(initial.source)}"></div>`
    + `<label class="check" data-for="question"><input type="checkbox" name="private"${initial.private ? " checked" : ""}>${esc(t("비공개 문의로 작성"))}</label>`
    + `<p class="community-muted" id="cf-visibility" role="status"></p>`
    + `<p class="community-error" role="alert"></p>`
    + `<div class="material-actions"><button class="btn" type="button" data-action="cancel-compose">${esc(t("취소"))}</button><button class="btn btn-primary" type="submit">${esc(post ? t("수정 저장") : t("게시하기"))}</button></div>`
    + `</form>`;
}

function syncCompose(): void {
  const form = document.querySelector<HTMLFormElement>("#composeForm");
  if (!form) return;
  const category = (form.elements.namedItem("category") as HTMLSelectElement).value;
  form.querySelectorAll<HTMLElement>("[data-for]").forEach(element => { element.hidden = element.dataset.for !== category; });
  const isPrivate = form.elements.namedItem("private") as HTMLInputElement;
  isPrivate.disabled = category !== "question";
  must("#cf-body-label").textContent = category === "resource" ? t("사용 방법과 적용 예시") : category === "question" ? t("문의 내용") : t("이야기");
  must("#cf-visibility").textContent = category === "question" && isPrivate.checked ? t("공개 범위: 작성자와 운영자")
    : form.dataset.wasPrivate === "true" ? t("비공개 문의를 공개 글로 바꿉니다. 저장하면 누구나 읽을 수 있습니다.") : t("공개 범위: 커뮤니티 전체");
}

function renderDetail(): void {
  const root = must("#detail");
  root.toggleAttribute("aria-busy", view.kind === "loading");
  switch (view.kind) {
    case "empty":
      root.innerHTML = `<div class="materials-empty-detail"><span aria-hidden="true">共</span><h2>${esc(t("함께 읽고,"))}<br>${esc(t("깊이 이해하다."))}</h2><p>${esc(t("글을 고르면 내용과 의견을 볼 수 있습니다. 질문과 해석, 나만의 방법을 나눠 주세요."))}</p></div>`;
      return;
    case "loading":
      root.innerHTML = detailSkeleton();
      return;
    case "missing":
      root.innerHTML = `<div class="materials-empty-detail"><h2>${esc(t("이 글을 볼 수 없습니다"))}</h2><p>${esc(t("삭제된 글이거나, 작성자와 운영자만 볼 수 있는 문의입니다."))}</p></div>`;
      return;
    case "error":
      root.innerHTML = `<div class="materials-empty-detail"><h2>${esc(t("글을 불러오지 못했습니다"))}</h2><p>${esc(view.message)}</p><button class="btn btn-sm" type="button" data-action="retry-post">${esc(t("다시 시도"))}</button></div>`;
      return;
    case "post":
      root.innerHTML = postMarkup(view.post, view.comments);
      return;
    case "compose":
      root.innerHTML = composeMarkup(view.post);
      syncCompose();
      must<HTMLInputElement>("#cf-title").focus();
  }
}

async function openPost(id: string): Promise<void> {
  saveDraft();
  selectedId = id;
  syncUrl();
  renderList();
  const request = ++threadRequest;
  if (view.kind !== "post" || view.post.id !== id) { view = { kind: "loading" }; renderDetail(); }
  try {
    const thread = await call(api.community.thread(id));
    if (request !== threadRequest) return;
    view = thread ? { kind: "post", ...thread } : { kind: "missing" };
    // The thread is fresher than the feed: keep counts and resolved state in step.
    if (thread) posts = posts.some(post => post.id === id) ? posts.map(post => post.id === id ? thread.post : post) : posts;
    renderList();
  } catch (error) {
    if (request !== threadRequest) return;
    view = { kind: "error", message: message(error) };
  }
  renderDetail();
}

function showEmpty(): void {
  threadRequest++;
  selectedId = null;
  view = { kind: "empty" };
  syncUrl();
  renderList();
  renderDetail();
}

function applyFeed(feed: CommunityFeed): void {
  loaded = true;
  member = feed.member;
  posts = feed.posts;
  bookmarks = new Set(feed.bookmarks);
  must("#communityMember").textContent = member.isModerator ? ui`${member.name} · 운영자` : member.name;
  must<HTMLButtonElement>("#btnCompose").disabled = false;
  must("#btnReports").hidden = !member.isModerator;
  renderCategories();
  renderList();
}

async function loadFeed(): Promise<void> {
  try {
    applyFeed(await call(api.community.feed()));
    if (selectedId) await openPost(selectedId);
    else renderDetail();
  } catch (error) {
    must("#postList").innerHTML = `<div class="empty"><p>${esc(message(error))}</p><button class="btn btn-sm" type="button" data-action="retry">${esc(t("다시 시도"))}</button></div>`;
    renderDetail();
  }
}

function openDialog(html: string): void {
  dialog.innerHTML = html;
  if (!dialog.open) dialog.showModal();
  dialog.querySelector<HTMLElement>("textarea, .btn-danger, .btn-primary")?.focus();
}

function confirmDialog(title: string, body: string, action: string, confirm: string, id = ""): void {
  openDialog(`<div class="dl-h" id="dlgCommunityTitle">${esc(title)}</div><div class="dl-b"><p>${esc(body)}</p></div>`
    + `<div class="dl-f"><button class="btn" type="button" data-action="close-dialog">${esc(t("취소"))}</button>`
    + `<button class="btn btn-danger" type="button" data-action="${action}" data-id="${esc(id)}">${esc(confirm)}</button></div>`);
}

async function showReports(): Promise<void> {
  const reports: CommunityReport[] = await call(api.community.reports());
  const title = posts.reduce((map, post) => map.set(post.id, post.title), new Map<string, string>());
  openDialog(`<div class="dl-h" id="dlgCommunityTitle">${esc(t("신고 관리"))}</div><div class="dl-b community-reports">`
    + (reports.length ? reports.map(report => `<article class="community-report"><strong>${esc(title.get(report.postId) ?? t("목록에 없는 글"))}</strong>`
      + `<p class="material-body">${esc(report.reason)}</p><span class="community-muted">${esc(when(report.createdAt))}</span>`
      + `<div class="community-form-actions"><button class="btn btn-sm" type="button" data-action="open-report-post" data-post="${esc(report.postId)}">${esc(t("글 보기"))}</button>`
      + `<button class="btn btn-sm" type="button" data-action="dismiss-report" data-id="${esc(report.id)}">${esc(t("검토 완료"))}</button></div></article>`).join("")
      : `<p class="community-muted">${esc(t("검토할 신고가 없습니다."))}</p>`)
    + `</div><div class="dl-f"><button class="btn" type="button" data-action="close-dialog">${esc(t("닫기"))}</button></div>`);
}

function currentPost(): CommunityPost | null {
  return view.kind === "post" ? view.post : null;
}

async function act(action: string, button: HTMLButtonElement): Promise<void> {
  const post = currentPost();
  switch (action) {
    case "retry": await loadFeed(); return;
    case "retry-post": if (selectedId) await openPost(selectedId); return;
    case "close-dialog": dialog.close(); return;
    case "cancel-compose": {
      const form = document.querySelector<HTMLFormElement>("#composeForm");
      const editing = form?.dataset.id || null;
      clearDraft(editing);
      if (editing) await openPost(editing); else showEmpty();
      return;
    }
    case "delete-comment":
      confirmDialog(t("의견을 삭제할까요?"), t("삭제한 의견은 되돌릴 수 없습니다."), "confirm-delete-comment", t("의견 삭제"), button.dataset.id);
      return;
    case "confirm-delete-comment":
      await call(api.community.deleteComment(button.dataset.id ?? ""));
      dialog.close();
      if (selectedId) await openPost(selectedId);
      notify(t("의견을 삭제했습니다."), t("커뮤니티"));
      return;
    case "confirm-delete-post": {
      const id = button.dataset.id ?? "";
      await call(api.community.deletePost(id));
      dialog.close();
      posts = posts.filter(item => item.id !== id);
      bookmarks.delete(id);
      renderCategories();
      showEmpty();
      notify(t("글을 삭제했습니다."), t("커뮤니티"));
      return;
    }
    case "open-report-post":
      dialog.close();
      await openPost(button.dataset.post ?? "");
      return;
    case "dismiss-report":
      await call(api.community.dismissReport(button.dataset.id ?? ""));
      await showReports();
      return;
  }
  if (!post) return;
  switch (action) {
    case "bookmark": {
      const saved = !bookmarks.has(post.id);
      await call(api.community.setBookmark(post.id, saved));
      if (saved) bookmarks.add(post.id); else bookmarks.delete(post.id);
      // Update in place so a half-written comment below is kept.
      button.textContent = saved ? t("저장 취소") : t("저장");
      button.setAttribute("aria-pressed", String(saved));
      renderCategories();
      renderList();
      return;
    }
    case "copy-link":
      await api.app.copyText(`${COMMUNITY_WEB_URL}?post=${encodeURIComponent(post.id)}`);
      notify(t("웹 링크를 복사했습니다."), t("커뮤니티"));
      return;
    case "copy-prompt":
      await api.app.copyText(post.prompt);
      notify(t("스킬·프롬프트를 복사했습니다."), t("커뮤니티"));
      return;
    case "report":
      openDialog(`<form id="reportForm" data-id="${esc(post.id)}" novalidate><div class="dl-h" id="dlgCommunityTitle">${esc(t("글 신고"))}</div>`
        + `<div class="dl-b"><p>${esc(t("운영자가 내용을 확인할 수 있도록 이유를 적어 주세요."))}</p>`
        + `<textarea class="textarea" name="reason" rows="4" maxlength="1000" aria-label="${esc(t("신고 사유"))}"></textarea><p class="community-error" role="alert"></p></div>`
        + `<div class="dl-f"><button class="btn" type="button" data-action="close-dialog">${esc(t("취소"))}</button><button class="btn btn-primary" type="submit">${esc(t("신고 보내기"))}</button></div></form>`);
      return;
    case "resolve":
      await call(api.community.resolvePost(post.id, !post.resolved));
      await openPost(post.id);
      return;
    case "edit":
      threadRequest++;
      view = { kind: "compose", post };
      renderDetail();
      return;
    case "delete-post":
      confirmDialog(t("이 글을 삭제할까요?"), t("글과 의견이 함께 삭제됩니다. 삭제 후에는 되돌릴 수 없습니다."), "confirm-delete-post", t("글 삭제"), post.id);
  }
}

async function submit(form: HTMLFormElement): Promise<void> {
  const error = form.querySelector<HTMLElement>(".community-error");
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!button || button.disabled) return;
  if (error) error.textContent = "";
  button.disabled = true;
  try {
    if (form.id === "composeForm") {
      const input = validateCommunityPost(formInput(form));
      const id = form.dataset.id || null;
      const saved = await call(id ? api.community.updatePost(id, input) : api.community.createPost(input));
      clearDraft(id);
      form.id = "savedComposeForm";
      posts = [saved, ...posts.filter(post => post.id !== saved.id)];
      renderCategories();
      await openPost(saved.id);
      notify(id ? t("글을 수정했습니다.") : t("새 글을 게시했습니다."), t("커뮤니티"));
    } else if (form.id === "commentForm" && selectedId) {
      const body = String(new FormData(form).get("body") ?? "").trim();
      if (!body) throw new Error(t("의견 내용을 입력해 주세요."));
      await call(api.community.addComment(selectedId, body));
      await openPost(selectedId);
      document.querySelector(".community-comment:last-of-type")?.scrollIntoView({ block: "nearest" });
    } else if (form.id === "reportForm") {
      const reason = String(new FormData(form).get("reason") ?? "").trim();
      if (reason.length < 5) throw new Error(t("신고 사유를 다섯 글자 이상 적어 주세요."));
      await call(api.community.report(form.dataset.id ?? "", reason));
      dialog.close();
      notify(t("운영자에게 신고를 접수했습니다."), t("커뮤니티"));
    }
  } catch (cause) {
    if (error?.isConnected) error.textContent = message(cause); else fail(cause);
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const row = target.closest<HTMLButtonElement>("[data-post]");
  if (row?.closest("#postList")) { void openPost(row.dataset.post!); return; }
  const category = target.closest<HTMLButtonElement>("[data-filter]");
  if (category) {
    filter = category.dataset.filter as Filter;
    renderCategories();
    renderList();
    return;
  }
  const tag = target.closest<HTMLButtonElement>("[data-tag]");
  if (tag) {
    query = tag.dataset.tag!;
    must<HTMLInputElement>("#q").value = query;
    filter = "all";
    renderCategories();
    renderList();
    return;
  }
  const button = target.closest<HTMLButtonElement>("button[data-action]");
  if (button) void busy(button, () => act(button.dataset.action!, button));
});

document.addEventListener("submit", (event) => {
  const form = event.target as HTMLFormElement;
  if (!["composeForm", "commentForm", "reportForm"].includes(form.id)) return;
  event.preventDefault();
  void submit(form);
});

document.addEventListener("input", (event) => {
  const target = event.target as HTMLElement;
  if (target.id === "q") { query = (target as HTMLInputElement).value; renderList(); }
  if (target.closest("#composeForm")) saveDraft();
});

document.addEventListener("change", (event) => {
  const target = event.target as HTMLInputElement;
  if (target.id === "sort") { sort = target.value; renderList(); }
  if (target.closest("#composeForm")) { syncCompose(); saveDraft(); }
});

must("#btnCompose").addEventListener("click", () => {
  if (!member) return;
  saveDraft();
  threadRequest++;
  selectedId = null;
  syncUrl();
  renderList();
  view = { kind: "compose", post: null };
  renderDetail();
});

must("#btnReports").addEventListener("click", (event) => {
  void busy(event.currentTarget as HTMLButtonElement, showReports);
});

window.addEventListener("pagehide", saveDraft);
window.addEventListener("munhae:document-created", (event) => {
  docs = (event as CustomEvent<HomeView>).detail.documents;
  renderSidebar(tree());
});

async function loadSidebar(): Promise<void> {
  const project = await api.project.getCurrent().catch(() => null);
  if (project) {
    setSidebarProject(project);
    const home = await api.home.get();
    if (home.ok) docs = home.data.documents;
  }
  renderSidebar(tree());
  bindSidebar((documentNodeId) => go("editor", documentNodeId), tree);
}

renderCategories();
must("#postList").innerHTML = listSkeleton();
if (selectedId) view = { kind: "loading" };
renderDetail();
// The auth gate reveals the page when this module finishes, so never wait on the network here.
void loadFeed();
await loadSidebar();
