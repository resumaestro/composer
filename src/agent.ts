import type { Env } from "./index";
import { queryVectorDatabase, type QueryVectorResult } from "./skills/queryVectorDatabase";
import { researchCompany, type CompanyResearch } from "./skills/researchCompany";
import { buildResume, type BuildResumeResult } from "./skills/buildResume";

export type WorkType = "remote" | "hybrid" | "onsite";

export interface PipelineInput {
  jobId: string;
  company: string;
  query: string;
  jobDescription?: string;
  address?: string;
  workType?: WorkType;
  topK?: number;
  callbackUrl?: string;
}

export interface PipelineResult {
  jobId: string;
  company: string;
  status: "ready_for_review" | "rejected";
  /** This pipeline never auto-submits: every result stops at a human review gate. */
  humanGate: true;
  evidence: QueryVectorResult;
  research: CompanyResearch;
  resume: BuildResumeResult | null;
  notes: string[];
  completedAt: string;
}

/**
 * Execution orchestrator. Runs the migrated skills in sequence:
 *
 *   1. queryVectorDatabase  (from job-vector)   -> supporting evidence from Vectorize
 *   2. researchCompany      (from job-research) -> company brief + hard-criteria screen + fit score
 *   3. buildResume          (from job-resume)   -> tailored one-page Markdown resume
 *
 * The orchestrator respects the candidate's hard criteria (it stops before building a resume for
 * an auto-rejected role) and never submits an application. It returns a result for human review.
 */
export async function runPipeline(env: Env, input: PipelineInput): Promise<PipelineResult> {
  const notes: string[] = [];

  // 1. Supporting evidence from the vector index.
  const evidence = await queryVectorDatabase(env, input.query, input.topK ?? 6);
  notes.push(`Vector query returned ${evidence.matches.length} match(es).`);

  // 2. Company research + hard-criteria screen.
  const research = await researchCompany(env, input.company, {
    address: input.address,
    workType: input.workType,
    jobText: input.jobDescription ?? input.query,
  });
  notes.push(`Research fit score: ${research.fitScore}/10.`);

  // Respect the hard criteria: if the role is auto-rejected, stop before building the resume.
  if (research.rejected) {
    notes.push(`Auto-rejected: ${research.rejectionReason ?? "did not meet hard criteria"}.`);
    return {
      jobId: input.jobId,
      company: input.company,
      status: "rejected",
      humanGate: true,
      evidence,
      research,
      resume: null,
      notes,
      completedAt: new Date().toISOString(),
    };
  }

  // 3. Synthesize the tailored resume from evidence + research context.
  const resume = await buildResume(env, {
    company: input.company,
    jobDescription: input.jobDescription ?? input.query,
    vectorContext: evidence.context,
    companyContext: research.summary,
  });
  notes.push(`Resume synthesized with ${resume.model}.`);

  return {
    jobId: input.jobId,
    company: input.company,
    status: "ready_for_review",
    humanGate: true,
    evidence,
    research,
    resume,
    notes,
    completedAt: new Date().toISOString(),
  };
}
