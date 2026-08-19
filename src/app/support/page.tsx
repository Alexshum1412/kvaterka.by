import type { Metadata } from 'next';
import Link from 'next/link';
import { Prose } from '@/ui/prose.tsx';

export const metadata: Metadata = {
  title: 'Поддержка',
  description: 'Что делать, если что-то пошло не так: спор по бронированию, проверка, доступ к аккаунту.',
};

/**
 * Support.
 *
 * Several screens tell a person to "write to support" and route them to
 * `/dashboard/chat`, which is a list of conversations about flats — there is
 * no support conversation type, and `startConversation` requires a real
 * property and a real owner, so no such thread can exist. The instruction was
 * a dead end.
 *
 * This page does not invent a channel that does not exist. What it does is
 * route each real problem to the mechanism that genuinely handles it — a
 * dispute has a queue and staff, verification has a resubmission path, account
 * data has a screen — and state plainly which problems currently have no
 * route, rather than sending somebody in a circle.
 */
export default function SupportPage() {
  return (
    <Prose
      title="Поддержка"
      lede="Большинство вопросов решается там, где возникла проблема. Ниже — куда идти с каждым из них."
    >
      <h2>Проблема с бронированием или арендой</h2>
      <p>
        Откройте карточку бронирования — там есть кнопка открыть спор. Спор попадает к сотруднику,
        который рассматривает его по переписке и отметкам о заезде и выезде. Это единственный путь, у
        которого есть срок, ответственный и запись решения.
      </p>
      <p>
        <Link href="/trips" className="link">
          Мои поездки
        </Link>{' '}
        ·{' '}
        <Link href="/dashboard/bookings" className="link">
          Бронирования моих квартир
        </Link>
      </p>

      <h2>Вопрос по проверке профиля</h2>
      <p>
        Если проверку отклонили, причина указана в решении, а заявку обычно можно подать заново,
        исправив то, что указано.
      </p>
      <p>
        <Link href="/dashboard/verification" className="link">
          Моя проверка
        </Link>
      </p>

      <h2>Объявление отклонили</h2>
      <p>
        Модератор указывает причину. Исправьте объявление и отправьте снова — это не блокировка, а
        замечание.
      </p>
      <p>
        <Link href="/dashboard" className="link">
          Мои квартиры
        </Link>
      </p>

      <h2>Сбор и задолженность</h2>
      <p>
        Каждое начисление видно с основанием: за какую аренду и от какой суммы.
      </p>
      <p>
        <Link href="/dashboard/finance" className="link">
          Финансы
        </Link>{' '}
        ·{' '}
        <Link href="/host/fees" className="link">
          Как считается сбор
        </Link>
      </p>

      <h2>Данные и учётная запись</h2>
      <p>
        Что о вас хранится и что происходит при закрытии учётной записи — на отдельных страницах.
      </p>
      <p>
        <Link href="/dashboard/account" className="link">
          Учётная запись
        </Link>{' '}
        ·{' '}
        <Link href="/privacy" className="link">
          Данные и приватность
        </Link>
      </p>

      <div className="prose__note">
        <p>
          <strong>Чего пока нет.</strong> Отдельного канала связи с поддержкой — почты, чата или формы
          — на площадке ещё нет, и мы не делаем вид, что он есть. Если ваш вопрос не решается ни одним
          из путей выше (например, вы не можете войти в аккаунт), сейчас он останется без ответа.
        </p>
        <p>Это известный пробел, а не недосмотр этой страницы.</p>
      </div>
    </Prose>
  );
}
