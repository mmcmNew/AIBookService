import React, { useState } from 'react';
import { X, Sparkles, Check, CreditCard, ShieldCheck, Zap, Loader2 } from 'lucide-react';
import { useUserStore } from '../../store/userStore';

interface TopUpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const PACKAGES = [
  {
    id: 'starter',
    title: 'Стартовый',
    characters: 200000,
    priceRub: 149,
    description: 'Хватит примерно на 1 небольшую книгу или повесть.',
    popular: false,
  },
  {
    id: 'reader',
    title: 'Книголюб',
    characters: 1000000,
    priceRub: 490,
    description: 'Хватит на 2–3 полноценных романа. Самый популярный выбор.',
    popular: true,
  },
  {
    id: 'marathon',
    title: 'Марафонец',
    characters: 3000000,
    priceRub: 1190,
    description: 'Хватит на большую книжную серию или библиотеку. Максимальная выгода.',
    popular: false,
  },
];

export const TopUpModal: React.FC<TopUpModalProps> = ({ isOpen, onClose }) => {
  const [selectedPack, setSelectedPack] = useState('reader');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const { balance, createPayment, fetchBalance, authFetch } = useUserStore();

  if (!isOpen) return null;

  const handlePay = async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const confirmationUrl = await createPayment(selectedPack);

      // Если в dev-режиме вернулась ссылка с mock_payment_id
      if (confirmationUrl.includes('mock_payment_id=')) {
        const urlParams = new URL(confirmationUrl).searchParams;
        const mockId = urlParams.get('mock_payment_id');
        if (mockId) {
          // Симулируем подтверждение оплаты в локальной среде
          const confirmRes = await authFetch('/api/payments/confirm-mock', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mockPaymentId: mockId }),
          });
          if (!confirmRes.ok) {
            const err = await confirmRes.json().catch(() => null);
            throw new Error(err?.error || `Не удалось подтвердить тестовый платёж (${confirmRes.status}).`);
          }
          await fetchBalance();
          setIsLoading(false);
          onClose();
          return;
        }
      }

      // В боевом режиме перенаправляем на официальную форму ЮKassa
      window.location.href = confirmationUrl;
    } catch (err: any) {
      console.error('Payment error:', err);
      setErrorMessage(err.message || 'Ошибка подключения к платежному шлюзу.');
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="w-full max-w-xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-3xl shadow-2xl overflow-hidden flex flex-col">
        
        {/* Шапка */}
        <div className="p-6 border-b border-slate-200 dark:border-zinc-800 flex items-center justify-between bg-gradient-to-r from-amber-500/10 via-transparent to-amber-500/5">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-amber-500 text-white shadow-sm">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-800 dark:text-zinc-100">
                Пополнение баланса символов
              </h2>
              <p className="text-xs text-slate-500 dark:text-zinc-400">
                Текущий остаток: <strong className="text-amber-600 dark:text-amber-400 font-mono">{balance.toLocaleString()}</strong> символов
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-xl text-slate-400 hover:text-slate-600 dark:hover:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Тело с тарифами */}
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {PACKAGES.map((pack) => {
              const isSelected = selectedPack === pack.id;
              return (
                <div
                  key={pack.id}
                  onClick={() => setSelectedPack(pack.id)}
                  className={`relative p-4 rounded-2xl border-2 cursor-pointer transition-all flex flex-col justify-between ${
                    isSelected
                      ? 'border-amber-500 bg-amber-50/50 dark:bg-amber-950/30 shadow-md scale-[1.02]'
                      : 'border-slate-200 dark:border-zinc-800 hover:border-slate-300 dark:hover:border-zinc-700 bg-white dark:bg-zinc-900'
                  }`}
                >
                  {pack.popular && (
                    <span className="absolute -top-2.5 right-3 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500 text-white shadow-sm">
                      Хит
                    </span>
                  )}

                  <div>
                    <h3 className="font-bold text-sm text-slate-800 dark:text-zinc-100 mb-1">
                      {pack.title}
                    </h3>
                    <div className="text-lg font-extrabold text-amber-600 dark:text-amber-400">
                      {pack.priceRub} ₽
                    </div>
                    <div className="text-xs font-semibold text-slate-600 dark:text-zinc-300 mt-1">
                      {(pack.characters / 1000).toLocaleString()}k символов
                    </div>
                  </div>

                  <p className="text-[11px] text-slate-500 dark:text-zinc-400 mt-3 border-t pt-2 border-slate-100 dark:border-zinc-800">
                    {pack.description}
                  </p>

                  <div className="mt-3 flex justify-end">
                    <div className={`w-5 h-5 rounded-full flex items-center justify-center border ${
                      isSelected ? 'bg-amber-500 border-amber-500 text-white' : 'border-slate-300 dark:border-zinc-700'
                    }`}>
                      {isSelected && <Check className="w-3.5 h-3.5" />}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Платежные методы ЮKassa */}
          <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-zinc-800/40 border border-slate-200 dark:border-zinc-800 flex items-center justify-between text-xs text-slate-600 dark:text-zinc-400">
            <div className="flex items-center gap-2">
              <CreditCard className="w-4 h-4 text-amber-500" />
              <span>Оплата через <strong>ЮKassa</strong>: СБП, карты МИР, Visa, Mastercard, SberPay, T-Pay</span>
            </div>
            <div className="flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
              <ShieldCheck className="w-4 h-4" />
              <span>Безопасно</span>
            </div>
          </div>

          {errorMessage && (
            <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/30 text-rose-600 dark:text-rose-400 text-xs text-center">
              {errorMessage}
            </div>
          )}
        </div>

        {/* Подвал */}
        <div className="p-5 border-t border-slate-200 dark:border-zinc-800 flex items-center justify-between bg-slate-50/50 dark:bg-zinc-950/40">
          <div className="text-xs text-slate-500 dark:text-zinc-400">
            Символы начисляются сразу после оплаты
          </div>

          <button
            onClick={handlePay}
            disabled={isLoading}
            className="px-6 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-600 active:scale-95 text-white font-bold text-xs shadow-md transition-all flex items-center gap-2 disabled:opacity-50"
          >
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Создание платежа...</span>
              </>
            ) : (
              <>
                <Zap className="w-4 h-4" />
                <span>Оплатить в ЮKassa</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
