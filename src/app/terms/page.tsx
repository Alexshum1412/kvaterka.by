import type { Metadata } from 'next';
import Link from 'next/link';
import { Prose } from '@/ui/prose.tsx';

export const metadata: Metadata = {
  title: 'Условия использования',
  description: 'Правила площадки Кватэрка.by и текущий статус юридических документов.',
};

/**
 * Terms of service, and the honest state of them.
 *
 * This page is deliberately NOT a terms-of-service document. No lawyer
 * qualified in Belarus has drafted or reviewed one, and inventing plausible
 * contractual language would be worse than a missing page: it would be a
 * document people rely on that binds nobody and asserts obligations nobody
 * checked. LEGAL_RISK_REGISTER.md records this as an open question, and this
 * page says the same thing in public rather than only in the repository.
 *
 * What it CAN state truthfully is how the platform actually behaves, because
 * that is observable in the code and enforced by tests. So the page describes
 * the rules the software applies today, and marks clearly where the formal
 * document is still missing.
 */
export default function TermsPage() {
  return (
    <Prose
      title="Условия использования"
      lede="Ниже описано, как площадка работает на самом деле. Формальный договор ещё не составлен — и мы говорим об этом прямо, а не прячем за общими словами."
    >
      <div className="prose__note">
        <p>
          <strong>Документ в подготовке.</strong> Пользовательское соглашение должен составить юрист,
          практикующий в Беларуси. Пока этого не произошло, мы не публикуем текст, который выглядел бы
          как договор, но не был бы им. Это сознательное решение: придуманные юридические
          формулировки опаснее их отсутствия.
        </p>
        <p>
          До появления соглашения площадка работает по правилам, описанным на этой странице. Они
          заложены в саму программу и применяются одинаково ко всем.
        </p>
      </div>

      <h2>Что делает площадка</h2>
      <p>
        Кватэрка — место, где хозяин публикует жильё, а арендатор его находит, задаёт вопросы,
        отправляет запрос и после аренды оставляет отзыв. Площадка хранит переписку, подтверждения и
        решения по спорам.
      </p>

      <h2>Чего площадка не делает</h2>
      <ul>
        <li>
          <strong>Не участвует в вашей сделке.</strong> Договор об аренде заключаете вы двое.
          Кватэрка не является его стороной.
        </li>
        <li>
          <strong>Не принимает арендную плату и залог.</strong> Деньги за аренду вы передаёте друг
          другу напрямую.
        </li>
        <li>
          <strong>Не гарантирует состояние жилья.</strong> Проверка объявления модератором — это
          проверка объявления, а не квартиры.
        </li>
      </ul>

      <h2>Сбор площадки</h2>
      <p>
        С хозяина начисляется 5% после завершённой аренды, подтверждённой обеими сторонами.{' '}
        <Link href="/host/fees" className="link">
          Как считается сбор
        </Link>
        .
      </p>

      <h2>Правила, которые площадка применяет сама</h2>
      <ul>
        <li>Контакты не раскрываются до подтверждения бронирования — это защищает обе стороны.</li>
        <li>Отзыв можно оставить только после состоявшейся аренды, по одному от каждой стороны.</li>
        <li>Отзывы обеих сторон публикуются одновременно.</li>
        <li>Финансовые записи и журнал действий неизменяемы, в том числе для сотрудников.</li>
        <li>Объявление проходит модерацию до публикации.</li>
      </ul>

      <h2>Спорные ситуации</h2>
      <p>
        Спор открывается из карточки бронирования. Решение принимает сотрудник площадки на основании
        переписки и отметок о заезде и выезде. Решение фиксируется и его нельзя переписать задним
        числом.
      </p>

      <p>
        Что происходит с вашими данными —{' '}
        <Link href="/privacy" className="link">
          на отдельной странице
        </Link>
        . Вопросы —{' '}
        <Link href="/support" className="link">
          в поддержку
        </Link>
        .
      </p>
    </Prose>
  );
}
