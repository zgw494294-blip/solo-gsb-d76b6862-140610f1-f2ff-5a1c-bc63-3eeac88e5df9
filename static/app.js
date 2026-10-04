"use strict";

const MAX_RUNNERS = 3;
const MAX_RECORDS = 40;
const GATE_LABELS = { S: "起点 S", M: "中途门 M", F: "终点 F" };

const runnerRows = document.getElementById("runner-rows");
const recordRows = document.getElementById("record-rows");
const addRunnerBtn = document.getElementById("add-runner");
const addRecordBtn = document.getElementById("add-record");
const recordCount = document.getElementById("record-count");
const form = document.getElementById("judge-form");
const errorBox = document.getElementById("error-box");
const pendingHint = document.getElementById("pending-hint");
const resultsBox = document.getElementById("results");

/* ---------- 行管理 ---------- */

function runnerRowHtml(index, value = "") {
  return `
    <div class="runner-row" data-index="${index}">
      <span class="row-index">选手 ${index}</span>
      <input type="number" min="1" step="1" class="runner-number" value="${escapeAttr(value)}" placeholder="正整数编号" />
      <button type="button" class="btn danger remove-runner" ${index === 1 ? "hidden" : ""}>删除</button>
    </div>`;
}

function recordRowHtml() {
  return `
    <tr class="record-row">
      <td><input type="text" class="rec-id" placeholder="唯一 ID" /></td>
      <td><input type="number" min="1" step="1" class="rec-runner" placeholder="选手编号" /></td>
      <td>
        <select class="rec-gate">
          <option value="">选择门</option>
          <option value="S">S 起点</option>
          <option value="M">M 中途门</option>
          <option value="F">F 终点</option>
        </select>
      </td>
      <td><input type="number" min="0" step="1" class="rec-time" placeholder="非负秒" /></td>
      <td><button type="button" class="btn danger remove-record">×</button></td>
    </tr>`;
}

function addRunnerRow(value) {
  if (runnerRows.children.length >= MAX_RUNNERS) return;
  runnerRows.insertAdjacentHTML("beforeend", runnerRowHtml(runnerRows.children.length + 1, value));
  refreshRunnerButtons();
}

function refreshRunnerButtons() {
  [...runnerRows.children].forEach((row, i) => {
    row.dataset.index = i + 1;
    row.querySelector(".row-index").textContent = `选手 ${i + 1}`;
    const btn = row.querySelector(".remove-runner");
    btn.hidden = runnerRows.children.length === 1;
  });
  addRunnerBtn.disabled = runnerRows.children.length >= MAX_RUNNERS;
}

function addRecordRow() {
  if (recordRows.children.length >= MAX_RECORDS) return;
  recordRows.insertAdjacentHTML("beforeend", recordRowHtml());
  refreshRecordCount();
}

function refreshRecordCount() {
  recordCount.textContent = `${recordRows.children.length} / ${MAX_RECORDS}`;
  addRecordBtn.disabled = recordRows.children.length >= MAX_RECORDS;
}

addRunnerBtn.addEventListener("click", () => {
  addRunnerRow();
  onInputChanged();
});
addRecordBtn.addEventListener("click", () => {
  addRecordRow();
  onInputChanged();
});

runnerRows.addEventListener("click", (e) => {
  if (e.target.classList.contains("remove-runner")) {
    e.target.closest(".runner-row").remove();
    refreshRunnerButtons();
    onInputChanged();
  }
});
recordRows.addEventListener("click", (e) => {
  if (e.target.classList.contains("remove-record")) {
    e.target.closest(".record-row").remove();
    refreshRecordCount();
    onInputChanged();
  }
});

/* ---------- 输入修改后自动重算 ---------- */

// 每次修改递增版本号：只有版本仍最新的响应才允许更新结果或错误，
// 过期的成功与失败一律丢弃，不得覆盖较新状态。
let inputVersion = 0;
let debounceTimer = null;
const DEBOUNCE_MS = 350; // 合并连续编辑为一次重算

function clearOutcome() {
  // 每次修改立即清掉旧结果与旧错误。
  resultsBox.innerHTML = "";
  errorBox.hidden = true;
}

function onInputChanged() {
  inputVersion += 1;
  clearOutcome();
  pendingHint.hidden = false;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    runAdjudication();
  }, DEBOUNCE_MS);
}

form.addEventListener("input", onInputChanged);
form.addEventListener("change", onInputChanged);

/* ---------- 收集与提交 ---------- */

function collectPayload() {
  const runners = [...runnerRows.querySelectorAll(".runner-row")]
    .map((row) => row.querySelector(".runner-number").value.trim())
    .filter((v) => v !== "")
    .map((v) => ({ number: v }));

  const records = [...recordRows.querySelectorAll(".record-row")].map((row) => ({
    id: row.querySelector(".rec-id").value.trim(),
    runner: row.querySelector(".rec-runner").value.trim(),
    gate: row.querySelector(".rec-gate").value,
    time: row.querySelector(".rec-time").value.trim(),
  }));

  return {
    standards: {
      smMin: document.getElementById("smMin").value.trim(),
      smMax: document.getElementById("smMax").value.trim(),
      mfMin: document.getElementById("mfMin").value.trim(),
      mfMax: document.getElementById("mfMax").value.trim(),
    },
    runners,
    records,
  };
}

async function runAdjudication() {
  const version = inputVersion;
  const payload = collectPayload();
  let resp;
  let data;
  try {
    resp = await fetch("/api/adjudicate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    data = await resp.json();
  } catch (err) {
    if (version !== inputVersion) return; // 过期的失败不得覆盖较新状态
    pendingHint.hidden = true;
    resultsBox.innerHTML = "";
    showError(`无法连接裁决服务：${err.message}`);
    return;
  }
  if (version !== inputVersion) return; // 过期的成功同样丢弃
  pendingHint.hidden = true;
  if (!resp.ok || !data.ok) {
    // 非法输入：清空结果区，只显示错误（不展示部分结果）。
    resultsBox.innerHTML = "";
    showError(data.error || "裁决失败");
  } else {
    errorBox.hidden = true;
    renderResults(data.result, normalizeRanges(payload.standards));
  }
}

// 手动裁决按钮仍然可用：跳过防抖立即重算，等待期间不锁定任何输入。
form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  // 等待重算期间同样隐藏结果与复核编辑；版本号递增使在途旧响应失效。
  inputVersion += 1;
  clearOutcome();
  pendingHint.hidden = false;
  runAdjudication();
});

function showError(msg) {
  errorBox.textContent = `⚠ ${msg}`;
  errorBox.hidden = false;
}

/* ---------- 人工复核（仅本次页面会话保留） ---------- */

const REVIEW_STATUSES = ["unreviewed", "pass", "question"];
const REVIEW_LABELS = { unreviewed: "未复核", pass: "通过", question: "存疑" };
const MAX_NOTE_LEN = 200;

// 复核只保存在内存中，刷新页面即清除；键绑定具体趟内容而非趟序号/行号。
const reviews = new Map(); // lapKey -> { status, note }

function normalizeRanges(standards) {
  // 仅在收到合法响应时调用：此时区间必为合法正整数。
  return {
    smLo: Number(standards.smMin),
    smHi: Number(standards.smMax),
    mfLo: Number(standards.mfMin),
    mfHi: Number(standards.mfMax),
  };
}

// 复核绑定：选手编号 + 三条记录（ID、门、秒数）+ 两段耗时区间。
// 任一绑定值改变都会得到不同的键，对应旧复核即被丢弃，改回也不恢复。
function lapKey(lap, runner, ranges) {
  // 用 JSON 序列化保证无分隔符碰撞：选手编号 + 三条记录的 ID/门/秒数 + 两段区间。
  return JSON.stringify([
    runner,
    lap.start.id,
    "S",
    lap.start.time,
    lap.middle.id,
    "M",
    lap.middle.time,
    lap.finish.id,
    "F",
    lap.finish.time,
    ranges.smLo,
    ranges.smHi,
    ranges.mfLo,
    ranges.mfHi,
  ]);
}

// 最新合法裁决中不再采纳的趟，其复核一并丢弃。
function pruneReviews(validKeys) {
  for (const key of reviews.keys()) {
    if (!validKeys.has(key)) reviews.delete(key);
  }
}

function getReview(key) {
  return reviews.get(key) || { status: "unreviewed", note: "" };
}

/* ---------- 结果渲染 ---------- */

function gateChip(gate, id, time) {
  return `<span class="chip ${gate}">
    <span class="chip-id">${escapeHtml(id)}</span>
    <span class="chip-t">${GATE_LABELS[gate]} · ${time} 秒</span>
  </span>`;
}

function reviewOptionsHtml(current) {
  return REVIEW_STATUSES.map(
    (s) =>
      `<option value="${s}"${s === current ? " selected" : ""}>${REVIEW_LABELS[s]}</option>`
  ).join("");
}

function reviewBoxHtml(key) {
  const review = getReview(key);
  return `
    <div class="lap-review" data-lap-key="${escapeAttr(key)}">
      <div class="review-ctrls">
        <label class="review-field">
          <span class="review-label">人工复核</span>
          <select class="review-status">${reviewOptionsHtml(review.status)}</select>
        </label>
        <button type="button" class="btn secondary small review-save">保存复核</button>
        <span class="review-pill ${review.status}">${REVIEW_LABELS[review.status]}</span>
        <span class="review-msg" role="status" hidden></span>
      </div>
      <textarea class="review-note" rows="2" maxlength="${MAX_NOTE_LEN}"
        placeholder="备注（至多 ${MAX_NOTE_LEN} 字；存疑须填写非空备注）">${escapeHtml(review.note)}</textarea>
      <div class="review-counter"><span class="review-len">${[...review.note].length}</span> / ${MAX_NOTE_LEN}</div>
    </div>`;
}

function renderResults(result, ranges) {
  const validKeys = new Set();
  for (const r of result.runners) {
    for (const lap of r.laps) validKeys.add(lapKey(lap, r.runner, ranges));
  }
  pruneReviews(validKeys);

  resultsBox.innerHTML = result.runners
    .map((r) => {
      const badge =
        r.lapCount === 0
          ? `<span class="badge zero">0 次完整计次</span>`
          : `<span class="badge ok">${r.lapCount} 次完整计次</span>`;
      const meta =
        r.lapCount === 0
          ? `<span class="result-meta">无完整计次</span>`
          : `<span class="result-meta">各趟用时之和：${r.totalTime} 秒</span>`;

      const lapsHtml =
        r.lapCount === 0
          ? `<div class="zero-note">该选手没有符合两段耗时区间的完整一趟，计 0 次；全部感应记录列入未采纳。</div>`
          : r.laps
              .map((lap, i) => {
                const key = lapKey(lap, r.runner, ranges);
                return `
                <div class="lap-item">
                  <div class="lap-title">第 ${i + 1} 趟 · 总用时 ${lap.totalTime} 秒</div>
                  <div class="lap-chain">
                    ${gateChip("S", lap.start.id, lap.start.time)}
                    <span class="arrow">— ${lap.smTime} 秒 →</span>
                    ${gateChip("M", lap.middle.id, lap.middle.time)}
                    <span class="arrow">— ${lap.mfTime} 秒 →</span>
                    ${gateChip("F", lap.finish.id, lap.finish.time)}
                  </div>
                  <div class="seg-times">
                    起点→中途门 <strong>${lap.smTime}</strong> 秒，
                    中途门→终点 <strong>${lap.mfTime}</strong> 秒
                  </div>
                  ${reviewBoxHtml(key)}
                </div>`;
              })
              .join("");

      const unusedHtml =
        r.unused.length === 0
          ? `<span class="empty-line">（无未采纳记录）</span>`
          : r.unused
              .map(
                (u) =>
                  `<span class="chip-mini ${u.gate}">${GATE_LABELS[u.gate]} · ${escapeHtml(
                    u.id
                  )} · ${u.time} 秒</span>`
              )
              .join("");

      return `
      <section class="result-card">
        <div class="result-head">
          <h3>选手 ${r.runner}</h3>
          ${badge}
          ${meta}
        </div>
        <div>${lapsHtml}</div>
        <div class="subsection">
          <h4>未采纳记录（该选手输入但未进入任何一趟）</h4>
          ${unusedHtml}
        </div>
      </section>`;
    })
    .join("");
}

/* ---------- 复核保存交互（不触发重算、不影响裁决） ---------- */

function setReviewMsg(box, text, ok) {
  const msg = box.querySelector(".review-msg");
  if (!text) {
    msg.hidden = true;
    msg.textContent = "";
    msg.classList.remove("error", "ok");
    return;
  }
  msg.textContent = text;
  msg.classList.toggle("error", !ok);
  msg.classList.toggle("ok", !!ok);
  msg.hidden = false;
}

// 保存失败时把控件还原为此前已保存的复核内容（默认“未复核”）。
function rollbackReview(box) {
  const saved = getReview(box.dataset.lapKey);
  box.querySelector(".review-status").value = saved.status;
  const note = box.querySelector(".review-note");
  note.value = saved.note;
  box.querySelector(".review-len").textContent = [...saved.note].length;
}

function saveReview(box) {
  const key = box.dataset.lapKey;
  const status = box.querySelector(".review-status").value;
  const note = box.querySelector(".review-note").value;

  if (!REVIEW_STATUSES.includes(status)) {
    rollbackReview(box);
    setReviewMsg(box, "复核状态非法，已保持原复核内容。", false);
    return;
  }
  if ([...note].length > MAX_NOTE_LEN) {
    rollbackReview(box);
    setReviewMsg(box, `备注至多 ${MAX_NOTE_LEN} 字，已保持原复核内容。`, false);
    return;
  }
  // 存疑必须有非空备注（去除首尾空白后仍须有内容）。
  if (status === "question" && note.trim() === "") {
    rollbackReview(box);
    setReviewMsg(box, "存疑必须填写非空备注，已保持原复核内容。", false);
    return;
  }

  if (status === "unreviewed" && note === "") {
    reviews.delete(key);
  } else {
    reviews.set(key, { status, note });
  }

  const pill = box.querySelector(".review-pill");
  pill.className = `review-pill ${status}`;
  pill.textContent = REVIEW_LABELS[status];
  setReviewMsg(box, "已保存（仅本次页面会话有效）", true);
}

// 复核控件位于表单之外，其编辑不触发自动重算。
resultsBox.addEventListener("click", (e) => {
  if (e.target.classList.contains("review-save")) {
    saveReview(e.target.closest(".lap-review"));
  }
});
resultsBox.addEventListener("input", (e) => {
  if (e.target.classList.contains("review-note")) {
    const box = e.target.closest(".lap-review");
    box.querySelector(".review-len").textContent = [...e.target.value].length;
    setReviewMsg(box, "", false); // 继续编辑时清除上次提示
  }
});
resultsBox.addEventListener("change", (e) => {
  if (e.target.classList.contains("review-status")) {
    setReviewMsg(e.target.closest(".lap-review"), "", false);
  }
});

/* ---------- 工具 ---------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}
function escapeAttr(s) {
  return escapeHtml(s);
}

/* ---------- 示例 / 清空 ---------- */

const SAMPLE = {
  smMin: "10",
  smMax: "60",
  mfMin: "10",
  mfMax: "60",
  runners: [{ number: "101" }, { number: "102" }],
  records: [
    { id: "a1", runner: "101", gate: "S", time: "0" },
    { id: "b1", runner: "101", gate: "M", time: "12" },
    { id: "c1", runner: "101", gate: "F", time: "25" },
    { id: "a2", runner: "101", gate: "S", time: "30" },
    { id: "b2", runner: "101", gate: "M", time: "45" },
    { id: "c2", runner: "101", gate: "F", time: "58" },
    { id: "x1", runner: "101", gate: "M", time: "200" },
    { id: "x2", runner: "101", gate: "S", time: "31" },
    { id: "d1", runner: "102", gate: "S", time: "5" },
    { id: "e1", runner: "102", gate: "M", time: "15" },
    { id: "f1", runner: "102", gate: "F", time: "25" },
  ],
};

function loadSample() {
  reviews.clear(); // 载入示例同时清掉此前的人工复核
  document.getElementById("smMin").value = SAMPLE.smMin;
  document.getElementById("smMax").value = SAMPLE.smMax;
  document.getElementById("mfMin").value = SAMPLE.mfMin;
  document.getElementById("mfMax").value = SAMPLE.mfMax;

  runnerRows.innerHTML = "";
  SAMPLE.runners.forEach((r) => addRunnerRow(r.number));
  refreshRunnerButtons();

  recordRows.innerHTML = "";
  SAMPLE.records.forEach(() => addRecordRow());
  [...recordRows.querySelectorAll(".record-row")].forEach((row, i) => {
    const rec = SAMPLE.records[i];
    row.querySelector(".rec-id").value = rec.id;
    row.querySelector(".rec-runner").value = rec.runner;
    row.querySelector(".rec-gate").value = rec.gate;
    row.querySelector(".rec-time").value = rec.time;
  });
  refreshRecordCount();

  onInputChanged(); // 载入示例后按当前完整输入自动重算
}

function clearAll() {
  // 递增版本号并取消待发的重算：之后在途请求返回也不得恢复结果或错误。
  inputVersion += 1;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  document.getElementById("smMin").value = "";
  document.getElementById("smMax").value = "";
  document.getElementById("mfMin").value = "";
  document.getElementById("mfMax").value = "";
  runnerRows.innerHTML = "";
  addRunnerRow();
  recordRows.innerHTML = "";
  addRecordRow();
  reviews.clear(); // 清空同时清掉全部人工复核
  clearOutcome(); // 同时清掉结果与错误
  pendingHint.hidden = true;
}

document.getElementById("sample-btn").addEventListener("click", loadSample);
document.getElementById("clear-btn").addEventListener("click", clearAll);

/* ---------- 初始行 ---------- */
addRunnerRow();
addRecordRow();
addRecordRow();
refreshRunnerButtons();
refreshRecordCount();
