/**
 * VRD 자율 에이전트 데몬
 *
 * agent_fix_jobs 테이블을 30초마다 폴링.
 * status = 'approved' 잡을 발견하면:
 *   1. status → 'in_progress'
 *   2. Claude Haiku로 patch_code 생성
 *   3. status → 'fixed', patch_code + affected_files 저장
 *   4. 실패 시 status → 'failed', error_message 저장
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "30000", 10);

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ANTHROPIC_API_KEY) {
  console.error("❌ 필수 환경변수 누락: SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Claude Haiku 패치 생성 ────────────────────────────────────────
async function generatePatch(job: Record<string, any>): Promise<{ patchCode: string; affectedFiles: string[] }> {
  const prompt = `당신은 VRD 쇼핑몰(Vite+React18+Express5+Drizzle+Supabase) 버그 수정 전문 AI입니다.
아래 버그 정보를 바탕으로 실제 코드 수정 패치를 생성하세요.

## 버그 정보
제목: ${job.feedback_title || "알 수 없음"}
설명: ${job.feedback_desc || "없음"}
발생 화면: ${job.feedback_tab || "없음"}

## AI 분석 결과
${job.fix_plan || JSON.stringify(job.analysis) || "분석 없음"}

## 출력 형식 (반드시 지켜주세요)
## 파일: [server/routes/xxx.ts 또는 client/src/pages/xxx.tsx 등 실제 경로]
### Before:
\`\`\`typescript
[기존 코드 — 수정할 부분만]
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

// ── 잡 1개 처리 ───────────────────────────────────────────────────
async function processJob(job: Record<string, any>): Promise<void> {
  const id = job.id;
  console.log(`[Daemon] 처리 시작: ${id} — ${job.feedback_title}`);

  // 1. status → in_progress (다른 데몬 인스턴스 중복 처리 방지)
  const { error: lockErr } = await supabase
    .from("agent_fix_jobs")
    .update({ status: "in_progress", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "approved"); // 이미 다른 프로세스가 가져간 경우 스킵

  if (lockErr) {
    console.warn(`[Daemon] 락 실패 (이미 처리 중): ${id}`);
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

    console.log(`[Daemon] ✅ 패치 완료: ${id} — 파일 ${affectedFiles.length}개`);
  } catch (err: any) {
    console.error(`[Daemon] ❌ 패치 실패: ${id} —`, err.message);
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

// ── 폴링 루프 ─────────────────────────────────────────────────────
async function poll(): Promise<void> {
  try {
    const { data: jobs, error } = await supabase
      .from("agent_fix_jobs")
      .select("*")
      .eq("status", "approved")
      .order("created_at", { ascending: true })
      .limit(5);

    if (error) {
      console.error("[Daemon] DB 조회 오류:", error.message);
      return;
    }

    if (!jobs || jobs.length === 0) return;

    console.log(`[Daemon] approved 잡 ${jobs.length}개 발견`);
    for (const job of jobs) {
      await processJob(job);
    }
  } catch (err: any) {
    console.error("[Daemon] poll 오류:", err.message);
  }
}

// ── 시작 ──────────────────────────────────────────────────────────
console.log(`[Daemon] VRD 자율 에이전트 시작 — 폴링 ${POLL_INTERVAL_MS / 1000}초 간격`);
console.log(`[Daemon] Supabase: ${SUPABASE_URL}`);

// 즉시 1회 실행 후 인터벌 시작
poll();
setInterval(poll, POLL_INTERVAL_MS);
