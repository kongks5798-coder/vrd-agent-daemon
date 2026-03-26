/**
 * VRD 자율 에이전트 데몬 v3
 *
 * Phase 1 — approved 잡:
 *   1. status → 'in_progress'
 *   2. GitHub에서 관련 파일 현재 내용 가져옴
 *   3. Claude Haiku에게 수정된 파일 전체 내용 생성 요청
 *   4. status → 'fixed', patch_code + affected_files 저장
 *
 * Phase 2 — fixed 잡:
 *   1. patch_code 파싱 → 파일별 전체 새 내용 추출
 *   2. GitHub Contents API로 파일 전체 덮어쓰기 + 커밋
 *   3. Vercel API로 배포 트리거
 *   4. status → 'deployed'
 *
 * v2와 차이: Before/After 패치 방식 폐기 → 수정된 파일 전체 교체
 *   v2: AI가 Before/After 생성 → 파일에서 Before 찾아 교체 → 불일치 시 실패
 *   v3: GitHub에서 현재 파일 가져옴 → AI가 전체 파일 수정 → 전체 덮어쓰기 → 항상 성공
 */

import { createClient } from "@supabase/supabase-js";

// ── 환경변수 ────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN!;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN!;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "30000", 10);

const GITHUB_OWNER = "kongks5798-coder";
const GITHUB_REPO = "Evolving-Digital-Territory";
const GITHUB_BRANCH = "main";
const VERCEL_PROJECT_ID = "prj_eYlh02HYw9s80qsAgTQr0QsuAhvh";
const VERCEL_TEAM_ID = "team_2ajNVK347eWEfCDu7ORw4dwI";

// 파일 크기 제한: 이 이상이면 스킵 (토큰 절약)
const MAX_FILE_LINES = 600;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ANTHROPIC_API_KEY) {
  console.error("❌ 필수 환경변수 누락: SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── GitHub 파일 가져오기 ──────────────────────────────────────────────
async function getGitHubFile(filePath: string): Promise<{ content: string; sha: string } | null> {
  if (!GITHUB_TOKEN) return null;
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}?ref=${GITHUB_BRANCH}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) return null;
  const data = await res.json() as any;
  const content = Buffer.from(data.content, "base64").toString("utf-8");
  return { content, sha: data.sha };
}

// ── GitHub 파일 전체 교체 커밋 ─────────────────────────────────────────
async function updateGitHubFile(
  filePath: string,
  newContent: string,
  sha: string,
  commitMessage: string
): Promise<string | null> {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      message: commitMessage,
      content: Buffer.from(newContent).toString("base64"),
      sha,
      branch: GITHUB_BRANCH,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`[GitHub] 파일 교체 실패 (${res.status}): ${filePath} — ${err.slice(0, 200)}`);
    return null;
  }
  const data = await res.json() as any;
  return data.commit?.html_url || null;
}

// ── Phase 1: Claude Haiku — 파일 전체 수정 버전 생성 ─────────────────────
async function generateFullFilePatch(
  job: Record<string, any>
): Promise<{ patchCode: string; affectedFiles: string[] }> {

  // 관련 파일 추론 (분석 결과에서 파일명 추출)
  const analysisText = job.fix_plan || JSON.stringify(job.analysis) || "";
  const mentionedFiles = extractLikelyFiles(analysisText, job.feedback_tab || "");

  // 언급된 파일의 현재 내용 가져오기 (최대 2개, 크기 제한)
  const fileContexts: string[] = [];
  for (const fp of mentionedFiles.slice(0, 2)) {
    const file = await getGitHubFile(fp);
    if (!file) continue;
    const lineCount = file.content.split("\n").length;
    if (lineCount > MAX_FILE_LINES) {
      fileContexts.push(`## 현재 파일: ${fp}\n(파일이 너무 큼: ${lineCount}줄 — 수정할 함수/섹션만 표시)\n${getRelevantSection(file.content, analysisText)}`);
    } else {
      fileContexts.push(`## 현재 파일: ${fp}\n\`\`\`typescript\n${file.content}\n\`\`\``);
    }
  }

  const prompt = `당신은 VRD 쇼핑몰(Vite+React18+Express5+Drizzle+Supabase) 버그 수정 전문 AI입니다.
아래 버그를 분석하고, 수정된 파일의 **전체 내용**을 출력하세요.

## VRD 기술 스택 (반드시 숙지)
- DB: Supabase PostgreSQL (isnwvodylbhhcestgzjm)
- 스토리지: Supabase Storage (버킷: bug-screenshots, vrd-products, banner-images) — AWS S3 사용 안 함
- 업로드 엔드포인트: /api/admin/bug-hunter/upload (server/routes/admin-crud.ts 내부)
- 인증: JWT (localStorage vrd_customer_token), requireAuth 미들웨어
- 결제: TossPayments v2 Widget

## 버그 정보
제목: ${job.feedback_title || "알 수 없음"}
설명: ${job.feedback_desc || "없음"}
발생 화면: ${job.feedback_tab || "없음"}

## AI 분석 결과
${analysisText}

${fileContexts.length > 0 ? fileContexts.join("\n\n") : ""}

## VRD 실제 파일 구조 (이 목록에서만 경로 선택)

### 서버 라우트 (server/routes/)
admin-crud.ts, admin-help.ts, admin-notifications.ts, admin-staff.ts,
affiliates.ts, agent-actions.ts, agent-bus.ts, ai-analytics.ts, ai-assistant.ts,
ai-content-gen.ts, ai-insight.ts, ai-product.ts, ai-usage.ts, alimtalk.ts,
anomaly.ts, auto-coupon-routes.ts, auto-reorder.ts, cart-recovery.ts, ceo-kpi.ts,
cms.ts, crm-360.ts, cron.ts, cs-ai-reply.ts, cs-templates.ts, cs-tickets.ts,
customer-auth.ts, customer-chat.ts, customer-journey.ts, customer-ltv.ts,
customer-score.ts, customer-segments.ts, daily-report.ts, delivery-tracking.ts,
display-order.ts, dynamic-pricing.ts, exchange-return.ts, health.ts,
inquiry-board.ts, inventory-alerts.ts, inventory-auto-order.ts, kakao-alimtalk.ts,
live-dashboard.ts, marketing.ts, multi-brand.ts, nl-query.ts, nps.ts, oms.ts,
order-notes.ts, payment-analytics.ts, payments.ts, phone-otp.ts, portal.ts,
product-marketing.ts, products.ts, push-notifications.ts, realtime-dashboard.ts,
recommendations.ts, retention.ts, review-sentiment.ts, sales-analysis.ts,
sales-heatmap.ts, segments.ts, semantic-search.ts, settlement.ts, sheets.ts,
shipping-track.ts, staff-chat.ts, staff-report.ts, stock.ts, suspicious.ts,
system-status.ts, vault-monitor.ts, vip-program.ts, webhooks.ts, wms.ts

### 서버 핵심 파일
server/routes.ts, server/storage.ts, server/db.ts, server/jarvis.ts, shared/schema.ts

### 클라이언트 페이지 (client/src/pages/)
home.tsx, shop.tsx, product-detail.tsx, cart.tsx, checkout.tsx, mypage.tsx,
login.tsx, products.tsx, search.tsx, wishlist.tsx, payment.tsx, payment-success.tsx,
admin/dashboard-tab.tsx, admin/products-tab.tsx, admin/orders-tab.tsx,
admin/customers-tab.tsx, admin/bug-hunter-tab.tsx, admin/banners-tab.tsx,
admin/stats-tab.tsx, admin/reviews-tab.tsx, admin/inventory-tab.tsx,
admin/marketing-tab.tsx, admin/settings-tab.tsx, admin/staff-tab.tsx,
admin/coupons-tab.tsx, admin/exchange-return-tab.tsx, admin/shipping-track-tab.tsx,
admin/segments-tab.tsx, admin/daily-report-tab.tsx, admin/cs-tickets-tab.tsx,
admin/super-admin.tsx, admin/dashboard.tsx, admin/login.tsx

## 출력 형식 (반드시 지켜주세요)
수정이 필요한 파일마다 아래 형식으로 출력:

## 파일: [위 목록에 있는 정확한 경로]
\`\`\`typescript
[수정된 파일의 전체 내용 — 생략 없이 완전한 파일]
\`\`\`
### 이유: [한국어로 설명]

규칙:
- 파일 전체를 출력하세요 (일부만 출력 금지)
- 600줄 초과 파일은 수정할 함수/섹션만 포함한 새 파일 작성
- 여러 파일이면 ## 파일: 섹션 반복
- 위 목록에 없는 경로 사용 금지`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API 오류 (${res.status}): ${err.slice(0, 200)}`);
  }

  const data = await res.json() as any;
  const patchCode: string = data.content?.[0]?.text || "패치 생성 실패";
  const affectedFiles: string[] = [...patchCode.matchAll(/##\s*파일:\s*(.+)/g)].map(
    (m: RegExpMatchArray) => m[1].trim()
  );

  return { patchCode, affectedFiles };
}

// ── 분석 텍스트에서 관련 파일 추론 ────────────────────────────────────
function extractLikelyFiles(analysisText: string, feedbackTab: string): string[] {
  const files: string[] = [];

  // 분석 결과에서 파일 경로 패턴 추출
  const pathPatterns = analysisText.match(/(?:server\/routes\/|client\/src\/pages\/|shared\/)\S+\.tsx?/g) || [];
  files.push(...pathPatterns);

  // 탭 이름으로 파일 추론
  const tabMap: Record<string, string[]> = {
    products: ["server/routes/products.ts", "client/src/pages/admin/products-tab.tsx"],
    orders: ["server/routes/admin-crud.ts", "client/src/pages/admin/orders-tab.tsx"],
    customers: ["server/routes/customer-auth.ts", "client/src/pages/admin/customers-tab.tsx"],
    payment: ["server/routes/payments.ts", "client/src/pages/checkout.tsx"],
    inventory: ["server/routes/stock.ts", "client/src/pages/admin/inventory-tab.tsx"],
    dashboard: ["client/src/pages/admin/dashboard-tab.tsx"],
    bug: ["server/routes/admin-crud.ts", "client/src/pages/admin/bug-hunter-tab.tsx"],
    shipping: ["server/routes/shipping-track.ts", "client/src/pages/admin/shipping-track-tab.tsx"],
  };

  for (const [key, mapped] of Object.entries(tabMap)) {
    if (feedbackTab.toLowerCase().includes(key) || analysisText.toLowerCase().includes(key)) {
      files.push(...mapped);
    }
  }

  // 중복 제거
  return [...new Set(files)].filter(f => f.endsWith(".ts") || f.endsWith(".tsx"));
}

// ── 큰 파일에서 관련 섹션만 추출 ─────────────────────────────────────
function getRelevantSection(content: string, analysisText: string): string {
  const lines = content.split("\n");
  // 분석 텍스트에 언급된 키워드로 관련 줄 찾기
  const keywords = analysisText.match(/\b\w{4,}\b/g)?.slice(0, 10) || [];
  const relevantLines: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (keywords.some(kw => lines[i].toLowerCase().includes(kw.toLowerCase()))) {
      // 전후 20줄 포함
      for (let j = Math.max(0, i - 20); j < Math.min(lines.length, i + 20); j++) {
        relevantLines.push(j);
      }
    }
  }

  if (relevantLines.length === 0) {
    // 키워드 매칭 없으면 앞 100줄
    return `\`\`\`typescript\n${lines.slice(0, 100).join("\n")}\n...(이하 생략)\n\`\`\``;
  }

  const uniqueLines = [...new Set(relevantLines)].sort((a, b) => a - b);
  const selected = uniqueLines.map(i => lines[i]).join("\n");
  return `\`\`\`typescript\n${selected}\n\`\`\``;
}

// ── Phase 1: 잡 패치 생성 ─────────────────────────────────────────────
async function processJob(job: Record<string, any>): Promise<void> {
  const id = job.id;
  console.log(`[Patch] 처리 시작: ${id} — ${job.feedback_title}`);

  const { error: lockErr } = await supabase
    .from("agent_fix_jobs")
    .update({ status: "in_progress", started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "approved");

  if (lockErr) {
    console.warn(`[Patch] 락 실패 (이미 처리 중): ${id}`);
    return;
  }

  try {
    const { patchCode, affectedFiles } = await generateFullFilePatch(job);

    await supabase
      .from("agent_fix_jobs")
      .update({
        status: "fixed",
        patch_code: patchCode,
        affected_files: affectedFiles.length ? affectedFiles : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    console.log(`[Patch] ✅ 패치 완료: ${id} — 파일 ${affectedFiles.length}개`);
  } catch (err: any) {
    console.error(`[Patch] ❌ 실패: ${id} —`, err.message);
    await supabase
      .from("agent_fix_jobs")
      .update({ status: "failed", error_message: err.message, updated_at: new Date().toISOString() })
      .eq("id", id);
  }
}

// ── Phase 2: patch_code 파싱 (전체 파일 방식) ─────────────────────────
interface FilePatch {
  filePath: string;
  newContent: string;
}

function parsePatchCode(patchCode: string): FilePatch[] {
  const patches: FilePatch[] = [];
  // ## 파일: 로 시작하는 섹션 분리 (앞에 다른 내용 있어도 OK)
  const fileRegex = /##\s*파일:\s*(.+?)\n[\s\S]*?```(?:typescript|tsx|ts|js|jsx)?\n([\s\S]+?)```/g;
  let match;
  while ((match = fileRegex.exec(patchCode)) !== null) {
    const filePath = match[1].trim().replace(/`/g, "");
    const newContent = match[2];
    if (filePath && newContent && newContent.length > 50) {
      patches.push({ filePath, newContent });
    }
  }
  return patches;
}

// ── Phase 2: Vercel 배포 트리거 ───────────────────────────────────────
async function triggerVercelDeploy(jobId: string): Promise<string | null> {
  if (!VERCEL_TOKEN) return null;

  const res = await fetch(
    `https://api.vercel.com/v13/deployments?teamId=${VERCEL_TEAM_ID}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${VERCEL_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "evolving-digital-territory",
        project: VERCEL_PROJECT_ID,
        target: "production",
        gitSource: { type: "github", org: GITHUB_OWNER, repo: GITHUB_REPO, ref: GITHUB_BRANCH },
        meta: { agentJobId: jobId },
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    console.error(`[Vercel] 배포 실패 (${res.status}): ${err.slice(0, 300)}`);
    return null;
  }

  const data = await res.json() as any;
  return data.url ? `https://${data.url}` : null;
}

// ── Phase 2: 전체 파일 교체 배포 파이프라인 ──────────────────────────
async function deployJob(job: Record<string, any>): Promise<void> {
  const id = job.id;
  if (!GITHUB_TOKEN) { console.warn(`[Deploy] GITHUB_TOKEN 없음 — 스킵: ${id}`); return; }

  const { error: lockErr } = await supabase
    .from("agent_fix_jobs")
    .update({ status: "applying", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "fixed");

  if (lockErr) { console.warn(`[Deploy] 락 실패: ${id}`); return; }

  console.log(`[Deploy] 배포 시작: ${id} — ${job.feedback_title}`);

  try {
    const patches = parsePatchCode(job.patch_code || "");
    if (patches.length === 0) throw new Error("파싱 가능한 파일 패치 없음");

    let commitUrl: string | null = null;
    const appliedFiles: string[] = [];
    const failedFiles: string[] = [];

    for (const patch of patches) {
      // 현재 파일 SHA 가져오기 (덮어쓰기에 필요)
      const current = await getGitHubFile(patch.filePath);
      if (!current) {
        console.warn(`[Deploy] GitHub 파일 없음: ${patch.filePath}`);
        failedFiles.push(patch.filePath);
        continue;
      }

      const commitMsg = `fix: ${job.feedback_title} [AUTO-DEPLOY]\n\nAgent job: ${id}`;
      const url = await updateGitHubFile(patch.filePath, patch.newContent, current.sha, commitMsg);

      if (url) { appliedFiles.push(patch.filePath); commitUrl = url; }
      else { failedFiles.push(patch.filePath); }
    }

    if (appliedFiles.length === 0) throw new Error(`모든 파일 적용 실패: ${failedFiles.join(", ")}`);

    const deploymentUrl = await triggerVercelDeploy(id);

    await supabase
      .from("agent_fix_jobs")
      .update({
        status: "deployed",
        github_pr_url: commitUrl,
        deployment_url: deploymentUrl,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        error_message: failedFiles.length ? `일부 파일 실패: ${failedFiles.join(", ")}` : null,
      })
      .eq("id", id);

    console.log(`[Deploy] ✅ 완료: ${id} — 적용 ${appliedFiles.length}개`);
    if (commitUrl) console.log(`[Deploy] GitHub: ${commitUrl}`);
    if (deploymentUrl) console.log(`[Deploy] Vercel: ${deploymentUrl}`);
  } catch (err: any) {
    console.error(`[Deploy] ❌ 실패: ${id} —`, err.message);
    await supabase
      .from("agent_fix_jobs")
      .update({ status: "failed", error_message: err.message, updated_at: new Date().toISOString() })
      .eq("id", id);
  }
}

// ── 폴링 루프 ─────────────────────────────────────────────────────────
async function poll(): Promise<void> {
  try {
    // Phase 1: approved 잡
    const { data: approvedJobs, error: e1 } = await supabase
      .from("agent_fix_jobs").select("*").eq("status", "approved")
      .order("created_at", { ascending: true }).limit(3);

    if (e1) console.error("[Poll] approved 조회 오류:", e1.message);
    else if (approvedJobs?.length) {
      console.log(`[Poll] approved 잡 ${approvedJobs.length}개`);
      for (const job of approvedJobs) await processJob(job);
    }

    // Phase 2: fixed 잡 배포
    if (GITHUB_TOKEN) {
      const { data: fixedJobs, error: e2 } = await supabase
        .from("agent_fix_jobs").select("*").eq("status", "fixed")
        .order("updated_at", { ascending: true }).limit(2);

      if (e2) console.error("[Poll] fixed 조회 오류:", e2.message);
      else if (fixedJobs?.length) {
        console.log(`[Poll] fixed 잡 ${fixedJobs.length}개 — 배포 시작`);
        for (const job of fixedJobs) await deployJob(job);
      }
    }
  } catch (err: any) {
    console.error("[Poll] 오류:", err.message);
  }
}

// ── 시작 ──────────────────────────────────────────────────────────────
console.log(`[Daemon] VRD 자율 에이전트 v3 시작 — 폴링 ${POLL_INTERVAL_MS / 1000}초 간격`);
console.log(`[Daemon] 방식: 파일 전체 교체 (Before/After 폐기)`);
console.log(`[Daemon] GitHub: ${GITHUB_TOKEN ? "✅" : "⚠️ 없음"} | Vercel: ${VERCEL_TOKEN ? "✅" : "⚠️ 없음"}`);

poll();
setInterval(poll, POLL_INTERVAL_MS);
