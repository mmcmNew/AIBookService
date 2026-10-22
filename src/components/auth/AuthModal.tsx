import React, { useState, useEffect, useCallback } from 'react';
import {
  X,
  Eye,
  EyeOff,
  Loader2,
  CheckCircle2,
  ArrowLeft,
  AlertCircle,
  Sparkles,
} from 'lucide-react';
import { Modal } from '../ui/Modal';
import { login, register, requestPasswordReset, ServerError } from '../../engine/account';
import { useToast } from '../ui/Toast';
import { useUserStore } from '../../store/userStore';

export interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialMode?: 'login' | 'register';
}

type AuthMode = 'login' | 'register' | 'forgot';

const REMEMBERED_EMAIL_KEY = 'ai_book_reader_remembered_email';

export const AuthModal: React.FC<AuthModalProps> = ({
  isOpen,
  onClose,
  initialMode = 'login',
}) => {
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isResetSuccess, setIsResetSuccess] = useState(false);

  const toast = useToast();
  const currentEmail = useUserStore((state) => state.email);

  // Сброс и синхронизация состояния при открытии
  useEffect(() => {
    if (isOpen) {
      setMode(initialMode);
      setError(null);
      setPassword('');
      setConfirmPassword('');
      setShowPassword(false);
      setShowConfirmPassword(false);
      setIsResetSuccess(false);

      const savedEmail = localStorage.getItem(REMEMBERED_EMAIL_KEY);
      if (savedEmail) {
        setEmail(savedEmail);
        setRememberMe(true);
      } else if (currentEmail) {
        setEmail(currentEmail);
      }
    }
  }, [isOpen, initialMode, currentEmail]);

  const switchMode = (newMode: AuthMode) => {
    setMode(newMode);
    setError(null);
    setPassword('');
    setConfirmPassword('');
    setIsResetSuccess(false);
  };

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setError('Введите email');
      return;
    }
    if (!password) {
      setError('Введите пароль');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      await login(trimmedEmail, password);

      if (rememberMe) {
        localStorage.setItem(REMEMBERED_EMAIL_KEY, trimmedEmail);
      } else {
        localStorage.removeItem(REMEMBERED_EMAIL_KEY);
      }

      toast.success('Вы успешно вошли в аккаунт');
      onClose();
    } catch (err) {
      const msg =
        err instanceof ServerError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Ошибка при входе в аккаунт';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !trimmedEmail.includes('@') || !trimmedEmail.includes('.')) {
      setError('Введите корректный адрес email');
      return;
    }

    if (password.length < 6) {
      setError('Пароль должен содержать не менее 6 символов');
      return;
    }

    if (password !== confirmPassword) {
      setError('Пароли не совпадают');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      await register(trimmedEmail, password);

      if (rememberMe) {
        localStorage.setItem(REMEMBERED_EMAIL_KEY, trimmedEmail);
      }

      toast.success('Аккаунт успешно создан');
      onClose();
    } catch (err) {
      const msg =
        err instanceof ServerError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Ошибка при регистрации';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  };

  const handleForgotSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !trimmedEmail.includes('@') || !trimmedEmail.includes('.')) {
      setError('Введите корректный адрес email');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      await requestPasswordReset(trimmedEmail);
      setIsResetSuccess(true);
    } catch (err) {
      const msg =
        err instanceof ServerError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Ошибка при отправке запроса на сброс пароля';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  };

  const inputClass =
    'w-full px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800/80 text-sm text-slate-800 dark:text-zinc-100 placeholder-slate-400 dark:placeholder-zinc-500 outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 transition-all';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      ariaLabel="Авторизация"
      panelClassName="w-full max-w-md bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-zinc-800 overflow-hidden text-slate-800 dark:text-zinc-100"
    >
      {/* Шапка модалки */}
      {mode === 'forgot' ? (
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => switchMode('login')}
              className="p-1 rounded-lg text-slate-500 hover:text-slate-800 dark:text-zinc-400 dark:hover:text-zinc-200 transition-colors"
              aria-label="Назад ко входу"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <h2 className="text-base font-bold text-slate-800 dark:text-zinc-100">
              Восстановление пароля
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:text-zinc-400 dark:hover:text-zinc-200 transition-colors"
            aria-label="Закрыть окно"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between border-b border-slate-100 dark:border-zinc-800 bg-slate-50/60 dark:bg-zinc-900/60">
          <div className="flex flex-1">
            <button
              type="button"
              onClick={() => switchMode('login')}
              className={`flex-1 py-3.5 text-center text-sm font-semibold transition-all relative ${
                mode === 'login'
                  ? 'text-amber-600 dark:text-amber-500 bg-white dark:bg-zinc-900'
                  : 'text-slate-500 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-200'
              }`}
            >
              Вход
              {mode === 'login' && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-amber-500" />
              )}
            </button>
            <button
              type="button"
              onClick={() => switchMode('register')}
              className={`flex-1 py-3.5 text-center text-sm font-semibold transition-all relative ${
                mode === 'register'
                  ? 'text-amber-600 dark:text-amber-500 bg-white dark:bg-zinc-900'
                  : 'text-slate-500 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-200'
              }`}
            >
              Регистрация
              {mode === 'register' && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-amber-500" />
              )}
            </button>
          </div>
          <div className="pr-4 pl-2">
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:text-zinc-400 dark:hover:text-zinc-200 transition-colors"
              aria-label="Закрыть окно"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
      )}

      {/* Тело модалки */}
      <div className="p-6">
        {/* Баннер ошибки */}
        {error && (
          <div className="mb-4 flex items-start gap-2.5 p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-600 dark:text-rose-400 text-xs">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span className="leading-snug">{error}</span>
          </div>
        )}

        {/* 1. Форма ВХОДА */}
        {mode === 'login' && (
          <form onSubmit={handleLoginSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-zinc-300 mb-1.5">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (error) setError(null);
                }}
                placeholder="name@example.com"
                required
                autoComplete="email"
                className={inputClass}
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold text-slate-600 dark:text-zinc-300">
                  Пароль
                </label>
                <button
                  type="button"
                  onClick={() => switchMode('forgot')}
                  className="text-xs text-amber-600 dark:text-amber-500 hover:underline"
                >
                  Забыли пароль?
                </button>
              </div>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (error) setError(null);
                  }}
                  placeholder="••••••••"
                  required
                  autoComplete="current-password"
                  className={`${inputClass} pr-10`}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600 dark:hover:text-zinc-200 transition-colors"
                  aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div className="flex items-center">
              <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-600 dark:text-zinc-400 select-none">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-300 dark:border-zinc-700 text-amber-500 focus:ring-amber-500/30"
                />
                <span>Запомнить меня</span>
              </label>
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-2.5 px-4 rounded-xl bg-amber-500 hover:bg-amber-600 active:scale-[0.99] text-white font-semibold text-sm transition-all shadow-sm disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>{isLoading ? 'Вход...' : 'Войти'}</span>
            </button>

            <div className="pt-2 text-center text-xs text-slate-500 dark:text-zinc-400">
              Нет аккаунта?{' '}
              <button
                type="button"
                onClick={() => switchMode('register')}
                className="text-amber-600 dark:text-amber-500 font-semibold hover:underline"
              >
                Зарегистрироваться
              </button>
            </div>
          </form>
        )}

        {/* 2. Форма РЕГИСТРАЦИИ */}
        {mode === 'register' && (
          <form onSubmit={handleRegisterSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-zinc-300 mb-1.5">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (error) setError(null);
                }}
                placeholder="name@example.com"
                required
                autoComplete="email"
                className={inputClass}
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-zinc-300 mb-1.5">
                Пароль (не менее 6 символов)
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (error) setError(null);
                  }}
                  placeholder="••••••••"
                  required
                  autoComplete="new-password"
                  className={`${inputClass} pr-10`}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600 dark:hover:text-zinc-200 transition-colors"
                  aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-zinc-300 mb-1.5">
                Повтор пароля
              </label>
              <div className="relative">
                <input
                  type={showConfirmPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => {
                    setConfirmPassword(e.target.value);
                    if (error) setError(null);
                  }}
                  placeholder="••••••••"
                  required
                  autoComplete="new-password"
                  className={`${inputClass} pr-10`}
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword((prev) => !prev)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600 dark:hover:text-zinc-200 transition-colors"
                  aria-label={showConfirmPassword ? 'Скрыть пароль' : 'Показать пароль'}
                >
                  {showConfirmPassword ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>

            {/* Текст о сохранении прогресса и баланса */}
            <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-900 dark:text-amber-200 text-xs flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-amber-500 shrink-0" />
              <span>
                При регистрации ваш текущий локальный прогресс чтения и баланс сохранятся
              </span>
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-2.5 px-4 rounded-xl bg-amber-500 hover:bg-amber-600 active:scale-[0.99] text-white font-semibold text-sm transition-all shadow-sm disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>{isLoading ? 'Создание аккаунта...' : 'Создать аккаунт'}</span>
            </button>

            <div className="pt-2 text-center text-xs text-slate-500 dark:text-zinc-400">
              Уже есть аккаунт?{' '}
              <button
                type="button"
                onClick={() => switchMode('login')}
                className="text-amber-600 dark:text-amber-500 font-semibold hover:underline"
              >
                Войти
              </button>
            </div>
          </form>
        )}

        {/* 3. Форма СБРОСА ПАРОЛЯ */}
        {mode === 'forgot' && (
          <div>
            {isResetSuccess ? (
              <div className="py-4 text-center space-y-4">
                <div className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-500 flex items-center justify-center mx-auto">
                  <CheckCircle2 className="w-6 h-6" />
                </div>
                <div className="space-y-1.5">
                  <h3 className="text-base font-semibold text-slate-900 dark:text-zinc-100">
                    Проверьте почту
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-zinc-400 max-w-xs mx-auto leading-relaxed">
                    Если аккаунт с адресом{' '}
                    <strong className="text-slate-700 dark:text-zinc-200 font-semibold">
                      {email}
                    </strong>{' '}
                    существует, мы отправили на него ссылку для восстановления пароля.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => switchMode('login')}
                  className="w-full py-2.5 px-4 rounded-xl bg-amber-500 hover:bg-amber-600 text-white font-semibold text-sm transition shadow-sm"
                >
                  Вернуться ко входу
                </button>
              </div>
            ) : (
              <form onSubmit={handleForgotSubmit} className="space-y-4">
                <p className="text-xs text-slate-500 dark:text-zinc-400 leading-relaxed">
                  Введите email, указанный при регистрации, и мы отправим ссылку для сброса пароля.
                </p>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 dark:text-zinc-300 mb-1.5">
                    Email
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      if (error) setError(null);
                    }}
                    placeholder="name@example.com"
                    required
                    autoComplete="email"
                    className={inputClass}
                  />
                </div>

                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full py-2.5 px-4 rounded-xl bg-amber-500 hover:bg-amber-600 active:scale-[0.99] text-white font-semibold text-sm transition-all shadow-sm disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                  <span>{isLoading ? 'Отправка...' : 'Отправить ссылку для сброса'}</span>
                </button>

                <div className="pt-2 text-center">
                  <button
                    type="button"
                    onClick={() => switchMode('login')}
                    className="text-xs text-amber-600 dark:text-amber-500 hover:underline inline-flex items-center gap-1 font-medium"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    <span>Вернуться ко входу</span>
                  </button>
                </div>
              </form>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
};
