import type { Metadata } from 'next';
import Link from 'next/link';
import { Prose } from '@/ui/prose.tsx';
import { Icon, type IconName } from '@/ui/icons.tsx';
import { Reveal } from '@/ui/reveal.tsx';

export const metadata: Metadata = {
  title: 'Доверие и безопасность',
  description:
    'Как Кватэрка.by отличает надёжного хозяина от случайного объявления: проверка, отзывы после реальной аренды, разбор споров.',
};

const TIERS: { icon: IconName; title: string; body: string }[] = [
  { icon: 'check', title: 'Базовый', body: 'Подтверждённый адрес почты или телефон.' },
  { icon: 'shieldCheck', title: 'Проверенный', body: 'Дополнительные подтверждения, рассмотренные сотрудником.' },
  {
    icon: 'shield',
    title: 'Подтверждённая личность',
    body: 'Требует документа — приём документов сейчас выключен до юридического решения, и уровень не выдаётся.',
  },
];

export default function TrustPage() {
  return (
    <>
      <nav aria-label="Хлебные крошки" className="page-crumb">
        <ol>
          <li>
            <Link href="/">Главная</Link>
            <Icon name="chevronRight" size={14} />
          </li>
          <li aria-current="page">Доверие и безопасность</li>
        </ol>
      </nav>

      <Prose
        title="Доверие и безопасность"
        lede="Главная проблема аренды — не поиск, а вопрос «можно ли верить этому человеку». Всё ниже устроено вокруг него."
      >
        <Reveal as="div">
          <h2>Отзыв нельзя купить</h2>
          <p>
            Отзыв привязан к конкретной завершённой аренде: по одному от каждой стороны, и только если
            аренда действительно состоялась. Написать отзыв «просто так» невозможно — не существует
            пути, по которому он попал бы в базу.
          </p>
          <p>
            Отзывы обеих сторон публикуются <strong>одновременно</strong>. Никто не может сначала
            прочитать чужой и подстроить свой, и никто не может промолчать в надежде, что второй тоже
            промолчит: если срок вышел, одинокий отзыв публикуется сам.
          </p>
          <p>
            В отзыве видна длительность проживания, но никогда — точные даты. Публиковать, когда
            квартира стояла пустой, значит создавать проблему безопасности.
          </p>
        </Reveal>

        <h2>Уровни проверки</h2>
        <ul className="tier-list" role="list">
          {TIERS.map((tier) => (
            <li key={tier.title} className="tier-list__item">
              <span className="tier-list__glyph">
                <Icon name={tier.icon} size={20} />
              </span>
              <div className="tier-list__copy">
                <b>{tier.title}</b>
                <p>{tier.body}</p>
              </div>
            </li>
          ))}
        </ul>
        <p>
          Решение по проверке принимает человек, оно фиксируется с причиной, и заявителю сообщается
          результат.{' '}
          <Link href="/dashboard/verification" className="link">
            Ваш статус проверки
          </Link>
          .
        </p>

        <h2>Рейтинг доверия объясним</h2>
        <p>
          На странице профиля видно не только число, но и из чего оно сложилось: сколько завершённых
          аренд, какие подтверждения есть, что говорят отзывы. Непрозрачная автоматическая оценка
          человека — это и продуктовая ошибка, и риск.
        </p>

        <h2>Общение остаётся на площадке</h2>
        <p>
          До подтверждения бронирования переписка идёт внутри Кватэрки, а попытки увести разговор в
          обход площадки скрываются — с объяснением отправителю, что и почему скрыто. Дело не в
          удержании: за пределами площадки не остаётся ни записи договорённостей, ни возможности
          разобрать спор.
        </p>

        <Reveal as="div">
          <h2>Если что-то пошло не так</h2>
          <p>
            Из карточки бронирования можно открыть спор. Сотрудник рассматривает его по переписке и
            отметкам о заезде и выезде. Решение нельзя переписать задним числом — журнал действий
            неизменяем даже для администратора.
          </p>

          <h2>Чего мы не обещаем</h2>
          <div className="prose__note">
            <p>
              Проверка объявления модератором — это проверка <strong>объявления</strong>. Мы не
              осматриваем квартиры, не проверяем право собственности и не гарантируем, что жильё
              соответствует фотографиям. Смотрите жильё до того, как передавать деньги.
            </p>
          </div>
        </Reveal>
      </Prose>

      <style>{`
        .page-crumb {
          max-width: 42rem;
          margin-inline: auto;
          padding-inline: 1rem;
          padding-block: var(--space-4) 0;
          font-size: var(--text-xs);
          color: var(--text-tertiary);
        }
        .page-crumb ol { display: flex; align-items: center; flex-wrap: wrap; gap: 0.35rem; list-style: none; padding: 0; margin: 0; }
        .page-crumb li { display: flex; align-items: center; gap: 0.35rem; }
        .page-crumb a { color: var(--text-tertiary); font-weight: 500; }
        .page-crumb a:hover { color: var(--primary); text-decoration: underline; text-underline-offset: 3px; }
        .page-crumb li[aria-current] { color: var(--text-secondary); font-weight: 500; }
        .page-crumb svg { flex: 0 0 auto; }
        @media (min-width: 768px) { .page-crumb { padding-inline: 1.5rem; } }

        /* Same icon-circle language as the home page's trust grid — apt here
           of all pages, since this literally is a trust section. */
        .tier-list { list-style: none; padding: 0; margin: 0 0 var(--space-3); display: flex; flex-direction: column; gap: var(--space-4); }
        .tier-list__item { display: flex; align-items: flex-start; gap: var(--space-4); }
        .tier-list__glyph {
          display: inline-flex; align-items: center; justify-content: center;
          flex: 0 0 auto;
          width: 2.75rem; height: 2.75rem;
          border-radius: var(--radius-full);
          background: var(--primary-soft);
          color: var(--primary);
        }
        .tier-list__copy b { display: block; color: var(--text-primary); font-weight: 600; font-size: var(--text-base); margin-bottom: 0.2rem; }
        .tier-list__copy p { margin: 0; color: var(--text-secondary); font-size: var(--text-sm); line-height: 1.6; }
      `}</style>
    </>
  );
}
