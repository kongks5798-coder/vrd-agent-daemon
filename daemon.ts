/**
 * VRD 자율 에이전트 데몬 v2
 *
 * Phase 1 — approved 잡:
 *   1. status → 'in_progress'
 *   2. Claude Haiku로 patch_code 생성
 *   3. status → 'fixed', patch_code + affected_files 저장
 *
 * Phase 2 — fixed 잡:
 *   1. patch_code 파싱 → 파일별 Before/After 추출
 *   2. GitHub Contents API로 파일 수정 + 커밋
 *   3. Vercel API로 배포 트리거
 *   4. status → 'deployed', github_pr_url + deployment_url 저장
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

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ANTHROPIC_API_KEY) {
  console.error("❌ 필수 환경변수 누락: SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Phase 1: Claude Haiku 패치 생성 ──────────────────────────────────
async function generatePatch(job: Record<string, any>): Promise<{ patchCode: string; affectedFiles: string[] }> {
  const prompt = `당신은 VRD 쇼핑몰(Vite+React18+Express5+Drizzle+Supabase) 버그 수정 전문 AI입니다.
아래 버그 정보를 바탕으로 실제 코드 수정 패치를 생성하세요.

## 버그 정보
제목: ${job.feedback_title || "알 수 없음"}
설명: ${job.feedback_desc || "없음"}
발생 화면: ${job.feedback_tab || "없음"}

## AI 분석 결과
${job.fix_plan || JSON.stringify(job.analysis) || "분석 없음"}

## VRD 실제 파일 구조 (반드시 이 목록에서만 경로 선택)

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
server/routes.ts, server/storage.ts, server/db.ts, server/jarvis.ts
shared/schema.ts

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
## 파일: [위 목록에 있는 정확한 경로만 사용]
### Before:
\`\`\`typescript
[기존 코드 — 수정할 부분만, 정확히 파일에 있는 코드]
\`\`\`
### After:
\`\`\`typescript
[수정된 코드]
\`\`\`
### 이유: [한국어로 설명]

여러 파일이면 ## 파일: 섹션을 반복하세요.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 3000,
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

// ── Phase 2: patch_code 파싱 ──────────────────────────────────────────
interface FilePatch {
  filePath: string;
  before: string;
  after: string;
}

function parsePatchCode(patchCode: string): FilePatch[] {
  const patches: FilePatch[] = [];
  // 각 ## 파일: 섹션을 분리
  const sections = patchCode.split(/\n(?=##\s*파일:)/);

  for (const section of sections) {
    const fileMatch = section.match(/##\s*파일:\s*(.+)/);
    if (!fileMatch) continue;

    const filePath = fileMatch[1].trim();

    // Before 블록 추출 (```typescript 또는 ``` 뒤 내용)
    const beforeMatch = section.match(/###\s*Before:\s*\n```(?:typescript|tsx|ts|js|jsx)?\n([\s\S]+?)```/);
    const afterMatch = section.match(/###\s*After:\s*\n```(?:typescript|tsx|ts|js|jsx)?\n([\s\S]+?)```/);

    if (!beforeMatch || !afterMatch) {
      console.warn(`[Deploy] 파싱 실패 (Before/After 없음): ${filePath}`);
      continue;
    }

    patches.push({
      filePath,
      before: beforeMatch[1],
      after: afterMatch[1],
    });
  }

  return patches;
}

// ── Phase 2: GitHub 파일 수정 ─────────────────────────────────────────
async function getGitHubFile(filePath: string): Promise<{ content: string; sha: string } | null> {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}?ref=${GITHUB_BRANCH}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!res.ok) {
    console.warn(`[GitHub] 파일 조회 실패 (${res.status}): ${filePath}`);
    return null;
  }

  const data = await res.json() as any;
  const content = Buffer.from(data.content, "base64").toString("utf-8");
  return { content, sha: data.sha };
}

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
    console.error(`[GitHub] 파일 수정 실패 (${res.status}): ${filePath} — ${err.slice(0, 200)}`);
    return null;
  }

  const data = await res.json() as any;
  return data.commit?.html_url || null;
}

// ── Phase 2: Vercel 배포 트리거 ───────────────────────────────────────
async function triggerVercelDeploy(jobId: string): Promise<string | null> {
  if (!VERCEL_TOKEN) {
    console.warn("[Vercel] VERCEL_TOKEN 없음 — 배포 스킵");
    return null;
  }

  const res = await fetch(
    `https://api.vercel.com/v13/deployments?teamId=${VERCEL_TEAM_ID}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${VERCEL_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "evolving-digital-territory",
        project: VERCEL_PROJECT_ID,
        target: "production",
        gitSource: {
          type: "github",
          org: GITHUB_OWNER,
          repo: GITHUB_REPO,
          ref: GITHUB_BRANCH,
        },
        meta: {
          agentJobId: jobId,
        },
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    console.error(`[Vercel] 배포 실패 (${res.status}): ${err.slice(0, 300)}`);
    return null;
  }

  const data = await res.json() as any;
  const deployUrl = data.url ? `https://${data.url}` : null;
  console.log(`[Vercel] 배포 시작: ${deployUrl}`);
  return deployUrl;
}

// ── Phase 2: 전체 배포 파이프라인 ────────────────────────────────────
async function deployJob(job: Record<string, any>): Promise<void> {
  const id = job.id;

  if (!GITHUB_TOKEN) {
    console.warn(`[Deploy] GITHUB_TOKEN 없음 — 배포 스킵: ${id}`);
    return;
  }

  // status → 'applying' (중복 처리 방지)
  const { error: lockErr } = await supabase
    .from("agent_fix_jobs")
    .update({ status: "applying", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "fixed");

  if (lockErr) {
    console.warn(`[Deploy] 락 실패 (이미 처리 중): ${id}`);
    return;
  }

  console.log(`[Deploy] 배포 시작: ${id} — ${job.feedback_title}`);

  try {
    const patches = parsePatchCode(job.patch_code || "");
    if (patches.length === 0) {
      throw new Error("파싱 가능한 파일 패치가 없습니다");
    }

    let commitUrl: string | null = null;
    const appliedFiles: string[] = [];
    const failedFiles: string[] = [];

    for (const patch of patches) {
      const file = await getGitHubFile(patch.filePath);
      if (!file) {
        failedFiles.push(patch.filePath);
        continue;
      }

      // Before 코드가 실제 파일에 존재하는지 확인
      if (!file.content.includes(patch.before)) {
        console.warn(`[Deploy] Before 코드 불일치 (스킵): ${patch.filePath}`);
        failedFiles.push(patch.filePath);
        continue;
      }

      const newContent = file.content.replace(patch.before, patch.after);
      const commitMsg = `fix: ${job.feedback_title} [AUTO-DEPLOY]\n\nAgent job: ${id}`;
      const url = await updateGitHubFile(patch.filePath, newContent, file.sha, commitMsg);

      if (url) {
        appliedFiles.push(patch.filePath);
        commitUrl = url;
      } else {
        failedFiles.push(patch.filePath);
      }
    }

    if (appliedFiles.length === 0) {
      throw new Error(`모든 파일 적용 실패: ${failedFiles.join(", ")}`);
    }

    // Vercel 배포 트리거
    const deploymentUrl = await triggerVercelDeploy(id);

    await supabase
      .from("agent_fix_jobs")
      .update({
        status: "deployed",
        github_pr_url: commitUrl,
        deployment_url: deploymentUrl,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        error_message: failedFiles.length
          ? `일부 파일 적용 실패: ${failedFiles.join(", ")}`
          : null,
      })
      .eq("id", id);

    console.log(`[Deploy] ✅ 완료: ${id} — 적용 ${appliedFiles.length}개, 실패 ${failedFiles.length}개`);
    if (commitUrl) console.log(`[Deploy] GitHub: ${commitUrl}`);
    if (deploymentUrl) console.log(`[Deploy] Vercel: ${deploymentUrl}`);
  } catch (err: any) {
    console.error(`[Deploy] ❌ 실패: ${id} —`, err.message);
    await supabase
      .from("agent_fix_jobs")
      .update({
        status: "failed",
        error_message: err.message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
  }
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
    const { patchCode, affectedFiles } = await generatePatch(job);

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
      .update({
        status: "failed",
        error_message: err.message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
  }
}

// ── 폴링 루프 ─────────────────────────────────────────────────────────
async function poll(): Promise<void> {
  try {
    // Phase 1: approved 잡 처리
    const { data: approvedJobs, error: e1 } = await supabase
      .from("agent_fix_jobs")
      .select("*")
      .eq("status", "approved")
      .order("created_at", { ascending: true })
      .limit(3);

    if (e1) {
      console.error("[Poll] DB 조회 오류:", e1.message);
    } else if (approvedJobs && approvedJobs.length > 0) {
      console.log(`[Poll] approved 잡 ${approvedJobs.length}개 발견`);
      for (const job of approvedJobs) {
        await processJob(job);
      }
    }

    // Phase 2: fixed 잡 배포
    if (GITHUB_TOKEN) {
      const { data: fixedJobs, error: e2 } = await supabase
        .from("agent_fix_jobs")
        .select("*")
        .eq("status", "fixed")
        .order("updated_at", { ascending: true })
        .limit(2);

      if (e2) {
        console.error("[Poll] fixed 잡 조회 오류:", e2.message);
      } else if (fixedJobs && fixedJobs.length > 0) {
        console.log(`[Poll] fixed 잡 ${fixedJobs.length}개 발견 — 배포 시작`);
        for (const job of fixedJobs) {
          await deployJob(job);
        }
      }
    }
  } catch (err: any) {
    console.error("[Poll] 오류:", err.message);
  }
}

// ── 시작 ──────────────────────────────────────────────────────────────
console.log(`[Daemon] VRD 자율 에이전트 v2 시작 — 폴링 ${POLL_INTERVAL_MS / 1000}초 간격`);
console.log(`[Daemon] Phase 1 (패치 생성): ✅`);
console.log(`[Daemon] Phase 2 (GitHub+Vercel 배포): ${GITHUB_TOKEN ? "✅" : "⚠️ GITHUB_TOKEN 없음"}`);

poll();
setInterval(poll, POLL_INTERVAL_MS);
