/** Public contact and bonus notice options shared by Host and Client. */
import z from '@ntars/schemastery'

/** Questionnaire destination and bonus notice timings shared by Host and Client. */
export interface ContactConfig {
  /** HTTPS questionnaire URL; override for a test form. */
  contactFormUrl: string
  /** Questionnaire source option; empty until Harness is supported by the form. */
  contactSource: string
  /** First delay before retrying a failed bonus acknowledgement. */
  bonusAckRetryDelayMs: number
  /** Ceiling for the acknowledgement retry backoff. */
  bonusAckRetryMaxDelayMs: number
}
/** Validate public questionnaire options. */
export const ContactConfigFields = {
  // The 意见反馈 entry in the sidebar's 更多 menu opens this Tencent 问卷. The
  // prefill contract in contact-url.ts is Feishu-shaped; a Tencent destination
  // simply ignores the suffixed hide_/prefill_ parameters.
  contactFormUrl: z.string().pattern(/^https:\/\/[^/\s]+\//).default('https://wj.qq.com/s2/28434196/mdox/'),
  contactSource: z.string().default(''),
  bonusAckRetryDelayMs: z.number().min(1).default(1_000),
  bonusAckRetryMaxDelayMs: z.number().min(1).default(60_000),
}
/** Validate public questionnaire options. */
export const ContactConfig: z<Partial<ContactConfig>, ContactConfig> = z.object(ContactConfigFields)
/** Bootstrap key containing no account credentials. */
export const CONTACT_CONFIG_GLOBAL = '__ONDRA_CONTACT_CONFIG__'
