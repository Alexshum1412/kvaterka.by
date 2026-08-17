/**
 * The moderation vocabulary.
 *
 * Pure data, no database, so the service, the API schema, the moderator's
 * form and the landlord's rejection notice all read the same list. A
 * duplicated copy of these codes would drift, and the one that drifted
 * would be the one shown to the landlord.
 *
 * The step map is why the codes exist at all: a rejection has to send the
 * landlord back to the screen that needs fixing, not to the start of a
 * nine-step wizard. Free text cannot do that.
 *
 * Mirrored by a CHECK constraint in migration 0009 — add to both.
 */

export const MODERATION_REASON_CODES = [
  'INSUFFICIENT_PHOTOS',
  'POOR_PHOTO_QUALITY',
  'INCORRECT_INFORMATION',
  'INSUFFICIENT_DESCRIPTION',
  'INCORRECT_PRICE',
  'INCORRECT_LOCATION',
  'PROHIBITED_CONTENT',
  'SUSPICIOUS_INFORMATION',
  'MISSING_INFORMATION',
  'VERIFICATION_REQUIRED',
  'OTHER',
] as const;

export type ModerationReasonCode = (typeof MODERATION_REASON_CODES)[number];

/** What the landlord reads. Plain, specific, and never accusatory. */
export const MODERATION_REASON_TEXT: Record<ModerationReasonCode, string> = {
  INSUFFICIENT_PHOTOS: 'Слишком мало фотографий',
  POOR_PHOTO_QUALITY: 'Фотографии не показывают жильё или плохого качества',
  INCORRECT_INFORMATION: 'Информация не соответствует действительности',
  INSUFFICIENT_DESCRIPTION: 'Описание слишком короткое или неинформативное',
  INCORRECT_PRICE: 'Цена указана некорректно',
  INCORRECT_LOCATION: 'Расположение указано неверно',
  PROHIBITED_CONTENT: 'Запрещённое содержание',
  SUSPICIOUS_INFORMATION: 'Данные требуют дополнительной проверки',
  MISSING_INFORMATION: 'Не хватает обязательной информации',
  VERIFICATION_REQUIRED: 'Требуется подтверждение личности или права сдавать объект',
  OTHER: 'Другая причина — смотрите комментарий модератора',
};

/** The shorter label a moderator picks from. */
export const MODERATION_REASON_SHORT: Record<ModerationReasonCode, string> = {
  INSUFFICIENT_PHOTOS: 'Мало фото',
  POOR_PHOTO_QUALITY: 'Качество фото',
  INCORRECT_INFORMATION: 'Неверные данные',
  INSUFFICIENT_DESCRIPTION: 'Слабое описание',
  INCORRECT_PRICE: 'Цена',
  INCORRECT_LOCATION: 'Расположение',
  PROHIBITED_CONTENT: 'Запрещённое содержание',
  SUSPICIOUS_INFORMATION: 'Подозрительные данные',
  MISSING_INFORMATION: 'Не хватает данных',
  VERIFICATION_REQUIRED: 'Нужна проверка личности',
  OTHER: 'Другое',
};

/**
 * Wizard step index each reason sends the landlord to.
 * Matches the STEPS array in src/ui/listing-wizard.tsx.
 */
export const MODERATION_REASON_STEP: Record<ModerationReasonCode, number> = {
  INSUFFICIENT_PHOTOS: 2,
  POOR_PHOTO_QUALITY: 2,
  INCORRECT_INFORMATION: 3,
  INSUFFICIENT_DESCRIPTION: 3,
  MISSING_INFORMATION: 3,
  INCORRECT_PRICE: 7,
  INCORRECT_LOCATION: 1,
  // Nothing specific to point at, so the review screen, where everything
  // is visible at once.
  PROHIBITED_CONTENT: 8,
  SUSPICIOUS_INFORMATION: 8,
  VERIFICATION_REQUIRED: 8,
  OTHER: 8,
};

/** The earliest step among the given reasons — where fixing should start. */
export function firstStepForReasons(codes: readonly string[]): number {
  const steps = codes
    .filter((c): c is ModerationReasonCode => c in MODERATION_REASON_STEP)
    .map((c) => MODERATION_REASON_STEP[c]);
  return steps.length > 0 ? Math.min(...steps) : 8;
}

export function reasonSentence(codes: readonly string[]): string {
  return codes
    .filter((c): c is ModerationReasonCode => c in MODERATION_REASON_TEXT)
    .map((c) => MODERATION_REASON_TEXT[c])
    .join('; ');
}
