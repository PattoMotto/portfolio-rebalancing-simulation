
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
  ComposedChart
} from 'recharts';
import {
  Settings,
  Activity,
  TrendingUp,
  RefreshCw,
  DollarSign,
  Maximize2,
  Zap,
  TrendingDown,
  Minus,
  AlertTriangle,
  Sliders
} from 'lucide-react';

// --- 1. Types & Interfaces ---

type ModelType = 'GBM' | 'OU' | 'JUMP';
type RebalanceType = 'threshold' | 'time';
type AllocationMode = 'fixed' | 'rsi' | 'adx';

interface MarketConfig {
  initialPrice: number;
  days: number;
  type: ModelType;
  drift: number; 
  volatility: number; 
  meanReversionSpeed: number; 
  longTermMean: number; 
  jumpIntensity: number; 
  jumpMean: number; 
  jumpStdDev: number; 
}

interface StrategyConfig {
  initialCapital: number;
  allocationMode: AllocationMode;
  targetAllocation: number;
  minAllocation: number;
  maxAllocation: number;
  indicatorPeriod: number;
  adxThreshold: number;
  rebalanceType: RebalanceType;
  rebalanceThreshold: number; 
  rebalanceFrequency: number; 
  transactionFeeRate: number; 
}

interface StepData {
  day: number;
  price: number;
  hodlValue: number;
  strategyValue: number;
  strategyCash: number;
  strategyAssetValue: number;
  allocation: number; 
  targetAllocation: number;
  rsi?: number;
  adx?: number;
  action: 'buy' | 'sell' | 'hold';
  tradeAmount?: number;
}

interface SimulationResult {
  data: StepData[];
  totalRebalances: number;
  totalFees: number;
  hodlReturn: number;
  strategyReturn: number;
  maxDrawdownHodl: number;
  maxDrawdownStrategy: number;
}

// --- 2. Math & Generator Functions (Pure JS, Client-Side) ---

const generateGaussian = (mean: number, stdDev: number): number => {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return z * stdDev + mean;
};

const generateGBM = (config: MarketConfig): number[] => {
  const dt = 1 / 252;
  const prices = [config.initialPrice];
  for (let i = 1; i <= config.days; i++) {
    const prevPrice = prices[i - 1];
    const shock = generateGaussian(0, 1);
    const driftComponent = (config.drift - 0.5 * Math.pow(config.volatility, 2)) * dt;
    const diffusionComponent = config.volatility * Math.sqrt(dt) * shock;
    const nextPrice = prevPrice * Math.exp(driftComponent + diffusionComponent);
    prices.push(nextPrice);
  }
  return prices;
};

const generateOU = (config: MarketConfig): number[] => {
  const dt = 1 / 252;
  const prices = [config.initialPrice];
  let currentLogPrice = Math.log(config.initialPrice);
  const targetLogPrice = Math.log(config.longTermMean);
  for (let i = 1; i <= config.days; i++) {
    const shock = generateGaussian(0, 1);
    const dX = config.meanReversionSpeed * (targetLogPrice - currentLogPrice) * dt + config.volatility * Math.sqrt(dt) * shock;
    currentLogPrice += dX;
    prices.push(Math.exp(currentLogPrice));
  }
  return prices;
};

const generateJump = (config: MarketConfig): number[] => {
  const dt = 1 / 252;
  const prices = [config.initialPrice];
  for (let i = 1; i <= config.days; i++) {
    const prevPrice = prices[i - 1];
    const shock = generateGaussian(0, 1);
    const driftComponent = (config.drift - 0.5 * Math.pow(config.volatility, 2)) * dt;
    const diffusionComponent = config.volatility * Math.sqrt(dt) * shock;
    let jumpComponent = 0;
    if (Math.random() < config.jumpIntensity * dt) {
      jumpComponent = generateGaussian(config.jumpMean, config.jumpStdDev);
    }
    const nextPrice = prevPrice * Math.exp(driftComponent + diffusionComponent + jumpComponent);
    prices.push(nextPrice);
  }
  return prices;
};

const generatePricePath = (config: MarketConfig): number[] => {
  switch (config.type) {
    case 'OU': return generateOU(config);
    case 'JUMP': return generateJump(config);
    case 'GBM': default: return generateGBM(config);
  }
};

// --- 3. Technical Indicators Logic ---

class TechnicalIndicators {
  private gains: number[] = [];
  private losses: number[] = [];
  private tr: number[] = [];
  private dmPlus: number[] = [];
  private dmMinus: number[] = [];
  private prices: number[] = [];

  constructor(private period: number) {}

  updateRSI(price: number, prevPrice: number): number | null {
    const change = price - prevPrice;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    this.gains.push(gain);
    this.losses.push(loss);
    if (this.gains.length > this.period) {
      this.gains.shift();
      this.losses.shift();
    }
    if (this.gains.length < this.period) return null;
    const avgGain = this.gains.reduce((a, b) => a + b, 0) / this.period;
    const avgLoss = this.losses.reduce((a, b) => a + b, 0) / this.period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  updateTrend(price: number, prevPrice: number): { adx: number, sma: number } | null {
    this.prices.push(price);
    if (this.prices.length > this.period) this.prices.shift();
    const currentTR = Math.abs(price - prevPrice);
    const moveUp = price - prevPrice;
    const moveDown = prevPrice - price;
    const currentDMPlus = (moveUp > 0 && moveUp > moveDown) ? moveUp : 0;
    const currentDMMinus = (moveDown > 0 && moveDown > moveUp) ? moveDown : 0;
    this.tr.push(currentTR);
    this.dmPlus.push(currentDMPlus);
    this.dmMinus.push(currentDMMinus);
    if (this.tr.length > this.period) {
      this.tr.shift();
      this.dmPlus.shift();
      this.dmMinus.shift();
    }
    if (this.tr.length < this.period) return null;
    const sumTR = this.tr.reduce((a, b) => a + b, 0);
    const sumDMPlus = this.dmPlus.reduce((a, b) => a + b, 0);
    const sumDMMinus = this.dmMinus.reduce((a, b) => a + b, 0);
    const sma = this.prices.reduce((a, b) => a + b, 0) / this.period;
    if (sumTR === 0) return { adx: 0, sma };
    const diPlus = (sumDMPlus / sumTR) * 100;
    const diMinus = (sumDMMinus / sumTR) * 100;
    const dx = Math.abs(diPlus - diMinus) / ((diPlus + diMinus) === 0 ? 1 : (diPlus + diMinus)) * 100;
    return { adx: dx, sma };
  }
}

// --- 4. Simulation Engine ---

const runSimulation = (
  market: MarketConfig,
  strategy: StrategyConfig,
  pricePath: number[]
): SimulationResult => {
  const data: StepData[] = [];
  let totalFees = 0;
  let rebalanceCount = 0;
  const indicators = new TechnicalIndicators(strategy.indicatorPeriod);

  let currentTargetAllocation = strategy.targetAllocation;
  if (strategy.allocationMode !== 'fixed') {
    currentTargetAllocation = 0.5;
  }

  const initialAssetValue = strategy.initialCapital * currentTargetAllocation;
  const initialCash = strategy.initialCapital * (1 - currentTargetAllocation);
  let strategyCash = initialCash;
  let strategyAssetCount = initialAssetValue / market.initialPrice;

  // HODL comparison: Fixed buy at start
  const hodlAssetCount = (strategy.initialCapital * strategy.targetAllocation) / market.initialPrice;
  const hodlCash = strategy.initialCapital * (1 - strategy.targetAllocation);

  data.push({
    day: 0,
    price: market.initialPrice,
    hodlValue: strategy.initialCapital,
    strategyValue: strategy.initialCapital,
    strategyCash: strategyCash,
    strategyAssetValue: strategyAssetCount * market.initialPrice,
    allocation: currentTargetAllocation,
    targetAllocation: currentTargetAllocation,
    action: 'hold'
  });

  let maxPeakHodl = strategy.initialCapital;
  let maxPeakStrategy = strategy.initialCapital;
  let maxDdHodl = 0;
  let maxDdStrategy = 0;

  for (let t = 1; t < pricePath.length; t++) {
    const price = pricePath[t];
    const prevPrice = pricePath[t-1];
    const rsiVal = indicators.updateRSI(price, prevPrice);
    const trendVal = indicators.updateTrend(price, prevPrice);

    // Dynamic Target Logic
    if (strategy.allocationMode === 'rsi' && rsiVal !== null) {
        let rsiFactor = (rsiVal - 30) / 40;
        rsiFactor = Math.max(0, Math.min(1, rsiFactor)); 
        currentTargetAllocation = strategy.maxAllocation - (rsiFactor * (strategy.maxAllocation - strategy.minAllocation));
    } else if (strategy.allocationMode === 'adx' && trendVal !== null) {
        const { adx, sma } = trendVal;
        const midPoint = (strategy.maxAllocation + strategy.minAllocation) / 2;
        if (adx > strategy.adxThreshold) {
           currentTargetAllocation = (price > sma) ? strategy.maxAllocation : strategy.minAllocation;
        } else {
           currentTargetAllocation = midPoint;
        }
    } else if (strategy.allocationMode === 'fixed') {
      currentTargetAllocation = strategy.targetAllocation;
    }

    // Metrics Update
    const currentHodlValue = hodlCash + (hodlAssetCount * price);
    maxPeakHodl = Math.max(maxPeakHodl, currentHodlValue);
    maxDdHodl = Math.max(maxDdHodl, (maxPeakHodl - currentHodlValue) / maxPeakHodl);

    let currentAssetValue = strategyAssetCount * price;
    let currentTotalStrategyValue = strategyCash + currentAssetValue;
    let currentAllocation = currentAssetValue / currentTotalStrategyValue;
    
    let action: 'buy' | 'sell' | 'hold' = 'hold';
    let tradeAmount = 0;

    // Rebalancing Logic
    let shouldRebalance = false;
    if (strategy.rebalanceType === 'threshold') {
      const deviation = Math.abs(currentAllocation - currentTargetAllocation);
      shouldRebalance = deviation > strategy.rebalanceThreshold;
    } else {
      shouldRebalance = (t % strategy.rebalanceFrequency === 0);
    }
    
    if (shouldRebalance) {
      const targetAssetValue = currentTotalStrategyValue * currentTargetAllocation;
      const diff = targetAssetValue - currentAssetValue;
      
      if (Math.abs(diff) > 1) { // Dust threshold
        rebalanceCount++;
        const fee = Math.abs(diff) * strategy.transactionFeeRate;
        totalFees += fee;
        strategyCash -= (diff + fee);
        strategyAssetCount += (diff / price);
        tradeAmount = diff;
        action = diff > 0 ? 'buy' : 'sell';
        currentAssetValue = strategyAssetCount * price;
        currentTotalStrategyValue = strategyCash + currentAssetValue;
        currentAllocation = currentAssetValue / currentTotalStrategyValue;
      }
    }

    maxPeakStrategy = Math.max(maxPeakStrategy, currentTotalStrategyValue);
    maxDdStrategy = Math.max(maxDdStrategy, (maxPeakStrategy - currentTotalStrategyValue) / maxPeakStrategy);

    data.push({
      day: t,
      price,
      hodlValue: currentHodlValue,
      strategyValue: currentTotalStrategyValue,
      strategyCash,
      strategyAssetValue: currentAssetValue,
      allocation: currentAllocation,
      targetAllocation: currentTargetAllocation,
      rsi: rsiVal ?? undefined,
      adx: trendVal?.adx ?? undefined,
      action,
      tradeAmount
    });
  }

  return {
    data,
    totalRebalances: rebalanceCount,
    totalFees,
    hodlReturn: (data[data.length - 1].hodlValue - strategy.initialCapital) / strategy.initialCapital,
    strategyReturn: (data[data.length - 1].strategyValue - strategy.initialCapital) / strategy.initialCapital,
    maxDrawdownHodl: maxDdHodl,
    maxDrawdownStrategy: maxDdStrategy
  };
};

// --- 5. Shared UI Components ---

const MetricCard = ({ label, value, subValue, type = 'neutral', icon: Icon }: any) => {
  const getColor = () => {
    if (type === 'good') return 'text-emerald-400';
    if (type === 'bad') return 'text-rose-400';
    return 'text-slate-200';
  };
  return (
    <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-4 flex flex-col justify-between backdrop-blur-sm">
      <div className="flex items-center justify-between mb-2">
        <span className="text-slate-400 text-sm font-medium">{label}</span>
        {Icon && <Icon size={16} className="text-slate-500" />}
      </div>
      <div>
        <div className={`text-2xl font-bold ${getColor()}`}>{value}</div>
        {subValue && <div className="text-xs text-slate-500 mt-1">{subValue}</div>}
      </div>
    </div>
  );
};

const NumberControl = ({ label, value, onChange, step = 0.01, min, max, isPercentage = false, prefix = '', disabled = false }: any) => {
  const isEditing = useRef(false);
  const formatValue = (v: number) => isPercentage ? (Math.round(v * 10000) / 100).toString() : v.toString();
  const [localVal, setLocalVal] = useState(() => formatValue(value));

  useEffect(() => {
    if (!isEditing.current) setLocalVal(formatValue(value));
  }, [value, isPercentage]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setLocalVal(raw);
    if (raw === '' || raw === '-') return;
    const parsed = parseFloat(raw);
    if (!isNaN(parsed)) {
      onChange(isPercentage ? parsed / 100 : parsed);
    }
  };

  return (
    <div className={`mb-4 ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
      <label className="text-xs font-medium text-slate-300 mb-1.5 block">{label}</label>
      <div className="relative group">
        {prefix && <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm pointer-events-none">{prefix}</span>}
        <input
          type="number"
          step={isPercentage ? step * 100 : step}
          min={min !== undefined ? (isPercentage ? min * 100 : min) : undefined}
          max={max !== undefined ? (isPercentage ? max * 100 : max) : undefined}
          value={localVal}
          onChange={handleChange}
          onFocus={() => isEditing.current = true}
          onBlur={() => isEditing.current = false}
          disabled={disabled}
          className={`w-full bg-slate-800 border border-slate-700 rounded-lg py-2 text-sm text-slate-200 focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all group-hover:border-slate-600 ${prefix ? 'pl-6' : 'px-3'} ${isPercentage ? 'pr-8' : 'px-3'}`}
        />
        {isPercentage && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 text-xs font-medium pointer-events-none">%</span>}
      </div>
    </div>
  );
};

// --- 6. Feature Sections (Components) ---

const MarketControls = ({ market, setMarket, regenerateMarket, applyPreset }: any) => (
  <>
    <div className="p-6 border-b border-slate-800">
      <div className="flex items-center gap-2 mb-1">
        <Activity className="text-indigo-500" />
        <h1 className="text-xl font-bold tracking-tight text-white">QuantSim</h1>
      </div>
      <p className="text-xs text-slate-500">Rebalancing vs. Buy & Hold</p>
    </div>

    <div className="p-6 pb-0">
       <section>
          <div className="flex items-center gap-2 mb-3 text-sm font-semibold text-slate-100 uppercase tracking-wider">
            <Zap size={14} className="text-yellow-500" />
            Quick Setup
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => applyPreset('BULL')} className="px-2 py-1.5 bg-slate-800 hover:bg-indigo-900/30 border border-slate-700 rounded text-xs text-emerald-400 flex items-center gap-1 justify-center transition-colors">
              <TrendingUp size={12} /> Bull Trend
            </button>
            <button onClick={() => applyPreset('BEAR')} className="px-2 py-1.5 bg-slate-800 hover:bg-rose-900/30 border border-slate-700 rounded text-xs text-rose-400 flex items-center gap-1 justify-center transition-colors">
              <TrendingDown size={12} /> Bear Trend
            </button>
            <button onClick={() => applyPreset('SIDEWAYS')} className="px-2 py-1.5 bg-slate-800 hover:bg-blue-900/30 border border-slate-700 rounded text-xs text-blue-400 flex items-center gap-1 justify-center transition-colors">
              <Minus size={12} /> Range (OU)
            </button>
            <button onClick={() => applyPreset('CRASH')} className="px-2 py-1.5 bg-slate-800 hover:bg-orange-900/30 border border-slate-700 rounded text-xs text-orange-400 flex items-center gap-1 justify-center transition-colors">
              <AlertTriangle size={12} /> Crash Risk
            </button>
            <button onClick={() => applyPreset('VOLATILE')} className="col-span-2 px-2 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded text-xs text-slate-300 flex items-center gap-1 justify-center transition-colors">
              <Activity size={12} /> High Volatility (No Trend)
            </button>
          </div>
        </section>
    </div>

    <div className="p-6">
      <section>
        <div className="flex items-center gap-2 mb-4 text-sm font-semibold text-slate-100 uppercase tracking-wider">
          <TrendingUp size={14} className="text-blue-500" />
          Market Params
        </div>
        <div className="mb-4">
            <label className="text-xs font-medium text-slate-300 mb-1.5 block">Pricing Model</label>
            <select 
              value={market.type}
              onChange={(e) => setMarket((p: MarketConfig) => ({ ...p, type: e.target.value as ModelType }))}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg py-2 px-3 text-sm text-slate-200 focus:ring-2 focus:ring-indigo-500 outline-none"
            >
              <option value="GBM">Geometric Brownian Motion</option>
              <option value="OU">Ornstein-Uhlenbeck (Range)</option>
              <option value="JUMP">Jump Diffusion (Shocks)</option>
            </select>
        </div>
        <NumberControl label="Duration (Days)" value={market.days} min={30} max={1000} step={10} onChange={(v: number) => setMarket((p: MarketConfig) => ({ ...p, days: v }))} />
        <NumberControl label="Volatility (Annual)" value={market.volatility} min={0.05} max={2.0} step={0.01} isPercentage={true} onChange={(v: number) => setMarket((p: MarketConfig) => ({ ...p, volatility: v }))} />
        
        {market.type === 'GBM' && (
          <NumberControl label="Drift (Annual Trend)" value={market.drift} min={-0.5} max={0.5} step={0.01} isPercentage={true} onChange={(v: number) => setMarket((p: MarketConfig) => ({ ...p, drift: v }))} />
        )}
        {market.type === 'OU' && (
          <>
            <NumberControl label="Mean Reversion Speed" value={market.meanReversionSpeed} min={0.1} max={20} step={0.1} onChange={(v: number) => setMarket((p: MarketConfig) => ({ ...p, meanReversionSpeed: v }))} />
            <NumberControl label="Target Price (Mean)" value={market.longTermMean} min={1} max={10000} step={1} prefix="$" onChange={(v: number) => setMarket((p: MarketConfig) => ({ ...p, longTermMean: v }))} />
          </>
        )}
        {market.type === 'JUMP' && (
          <>
             <NumberControl label="Drift (Base Trend)" value={market.drift} min={-0.5} max={0.5} step={0.01} isPercentage={true} onChange={(v: number) => setMarket((p: MarketConfig) => ({ ...p, drift: v }))} />
            <NumberControl label="Jump Intensity (per year)" value={market.jumpIntensity} min={0} max={50} step={0.5} onChange={(v: number) => setMarket((p: MarketConfig) => ({ ...p, jumpIntensity: v }))} />
            <NumberControl label="Avg Jump Size" value={market.jumpMean} min={-0.5} max={0.5} step={0.01} isPercentage={true} onChange={(v: number) => setMarket((p: MarketConfig) => ({ ...p, jumpMean: v }))} />
          </>
        )}
        
        <button onClick={regenerateMarket} className="w-full mt-2 py-2 px-4 bg-slate-800 hover:bg-slate-700 border border-slate-600 rounded-lg text-xs font-medium text-indigo-300 transition-colors flex items-center justify-center gap-2">
          <RefreshCw size={12} /> Regenerate Market Path
        </button>
      </section>
    </div>
  </>
);

const StrategyControls = ({ strategy, setStrategy }: any) => (
  <div className="p-6 pt-0">
      <section>
        <div className="flex items-center gap-2 mb-4 text-sm font-semibold text-slate-100 uppercase tracking-wider">
          <Settings size={14} className="text-emerald-500" />
          Strategy Config
        </div>

        <NumberControl label="Initial Capital" value={strategy.initialCapital} min={1000} max={1000000} step={1000} prefix="$" onChange={(v: number) => setStrategy((p: StrategyConfig) => ({ ...p, initialCapital: v }))} />

        <div className="mb-4">
            <label className="text-xs font-medium text-slate-300 mb-1.5 block">Allocation Mode</label>
            <div className="flex flex-col gap-1">
              <select 
                value={strategy.allocationMode}
                onChange={(e) => setStrategy((p: StrategyConfig) => ({ ...p, allocationMode: e.target.value as AllocationMode }))}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg py-2 px-3 text-sm text-slate-200 focus:ring-2 focus:ring-indigo-500 outline-none"
              >
                <option value="fixed">Fixed Target</option>
                <option value="rsi">Auto (RSI Contrarian)</option>
                <option value="adx">Auto (Trend Following)</option>
              </select>
              <p className="text-[10px] text-slate-500 mt-1 px-1">
                {strategy.allocationMode === 'fixed' && "Maintains constant exposure."}
                {strategy.allocationMode === 'rsi' && "Buys dips (Low RSI), Sells rips (High RSI)."}
                {strategy.allocationMode === 'adx' && "Increases exposure during strong uptrends."}
              </p>
            </div>
        </div>

        {strategy.allocationMode === 'fixed' ? (
          <NumberControl label="Target Allocation" value={strategy.targetAllocation} min={0.0} max={1.0} step={0.01} isPercentage={true} onChange={(v: number) => setStrategy((p: StrategyConfig) => ({ ...p, targetAllocation: v }))} />
        ) : (
          <>
              <div className="grid grid-cols-2 gap-2">
                <NumberControl label="Min Alloc" value={strategy.minAllocation} min={0.0} max={1.0} step={0.05} isPercentage={true} onChange={(v: number) => setStrategy((p: StrategyConfig) => ({ ...p, minAllocation: v }))} />
                <NumberControl label="Max Alloc" value={strategy.maxAllocation} min={0.0} max={1.0} step={0.05} isPercentage={true} onChange={(v: number) => setStrategy((p: StrategyConfig) => ({ ...p, maxAllocation: v }))} />
              </div>
              <NumberControl label={strategy.allocationMode === 'rsi' ? "RSI Period" : "ADX Period"} value={strategy.indicatorPeriod} min={2} max={50} step={1} onChange={(v: number) => setStrategy((p: StrategyConfig) => ({ ...p, indicatorPeriod: v }))} />
              {strategy.allocationMode === 'adx' && (
                  <NumberControl label="Trend Strength (ADX Threshold)" value={strategy.adxThreshold} min={10} max={50} step={1} onChange={(v: number) => setStrategy((p: StrategyConfig) => ({ ...p, adxThreshold: v }))} />
              )}
          </>
        )}

        <div className="border-t border-slate-800 my-4"></div>

        <div className="mb-4">
            <label className="text-xs font-medium text-slate-300 mb-1.5 block">Rebalance Trigger</label>
            <div className="flex bg-slate-800 p-1 rounded-lg border border-slate-700">
              <button onClick={() => setStrategy((p: StrategyConfig) => ({ ...p, rebalanceType: 'threshold' }))} className={`flex-1 py-1.5 text-xs font-medium rounded transition-colors ${strategy.rebalanceType === 'threshold' ? 'bg-slate-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'}`}>
                Threshold
              </button>
              <button onClick={() => setStrategy((p: StrategyConfig) => ({ ...p, rebalanceType: 'time' }))} className={`flex-1 py-1.5 text-xs font-medium rounded transition-colors ${strategy.rebalanceType === 'time' ? 'bg-slate-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'}`}>
                Time
              </button>
            </div>
        </div>

        {strategy.rebalanceType === 'threshold' ? (
          <NumberControl label="Rebalance Threshold" value={strategy.rebalanceThreshold} min={0.0} max={0.5} step={0.001} isPercentage={true} onChange={(v: number) => setStrategy((p: StrategyConfig) => ({ ...p, rebalanceThreshold: v }))} />
        ) : (
            <NumberControl label="Frequency (Days)" value={strategy.rebalanceFrequency} min={1} max={365} step={1} onChange={(v: number) => setStrategy((p: StrategyConfig) => ({ ...p, rebalanceFrequency: v }))} />
        )}

        <NumberControl label="Transaction Fee" value={strategy.transactionFeeRate} min={0.0} max={0.1} step={0.0001} isPercentage={true} onChange={(v: number) => setStrategy((p: StrategyConfig) => ({ ...p, transactionFeeRate: v }))} />
      </section>
  </div>
);

const StatsPanel = ({ simResult }: { simResult: SimulationResult }) => {
  const formatCurrency = (val: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(val);
  const formatPercent = (val: number) => `${(val * 100).toFixed(2)}%`;
  
  if (!simResult) return null;

  const currentStep = simResult.data[simResult.data.length-1];

  return (
    <div className="h-auto min-h-[140px] p-6 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 bg-slate-950 z-10">
      <MetricCard 
        label="Strategy Equity" 
        value={formatCurrency(currentStep.strategyValue)} 
        subValue={`${formatPercent(simResult.strategyReturn)} Return`}
        type={simResult.strategyReturn > simResult.hodlReturn ? 'good' : 'neutral'}
        icon={DollarSign}
      />
      <MetricCard 
        label="Buy & Hold Equity" 
        value={formatCurrency(currentStep.hodlValue)} 
        subValue={`${formatPercent(simResult.hodlReturn)} Return`}
        icon={Maximize2}
      />
      <MetricCard 
        label="Alpha (Strategy vs HODL)" 
        value={formatCurrency(currentStep.strategyValue - currentStep.hodlValue)}
        subValue={`${formatPercent(simResult.strategyReturn - simResult.hodlReturn)} Diff`}
        type={simResult.strategyReturn >= simResult.hodlReturn ? 'good' : 'bad'}
        icon={TrendingUp}
      />
      <MetricCard 
        label="Max Drawdown" 
        value={formatPercent(simResult.maxDrawdownStrategy)}
        subValue={`HODL: ${formatPercent(simResult.maxDrawdownHodl)}`}
        type={simResult.maxDrawdownStrategy < simResult.maxDrawdownHodl ? 'good' : 'bad'}
        icon={TrendingDown}
      />
      <MetricCard 
        label="Execution Stats" 
        value={`${simResult.totalRebalances} Trades`}
        subValue={`Fees: ${formatCurrency(simResult.totalFees)}`}
        icon={RefreshCw}
      />
    </div>
  );
};

const ChartsPanel = ({ simResult, strategy }: { simResult: SimulationResult, strategy: StrategyConfig }) => {
  const formatCurrency = (val: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(val);
  
  const RebalanceDot = (props: any) => {
    const { cx, cy, payload } = props;
    if (payload.action === 'buy') return <circle cx={cx} cy={cy} r={4} fill="#10b981" stroke="#fff" strokeWidth={1} />;
    if (payload.action === 'sell') return <circle cx={cx} cy={cy} r={4} fill="#f43f5e" stroke="#fff" strokeWidth={1} />;
    return null;
  };

  if (!simResult) return null;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      
      {/* Main Performance Chart */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-sm">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-sm font-medium text-slate-300 flex items-center gap-2">
            <TrendingUp size={16} /> Performance Comparison
          </h3>
          <div className="flex gap-4 text-xs">
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500"></span> Rebalanced Strategy</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-slate-500"></span> Buy & Hold</span>
          </div>
        </div>
        <div className="h-[300px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={simResult.data}>
              <defs>
                <linearGradient id="colorStrat" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.3}/>
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
              <XAxis dataKey="day" stroke="#475569" tick={{fontSize: 12}} minTickGap={30} />
              <YAxis stroke="#475569" tick={{fontSize: 12}} domain={['auto', 'auto']} tickFormatter={(v) => `$${v/1000}k`} />
              <Tooltip 
                contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', color: '#f1f5f9' }}
                formatter={(val: number) => formatCurrency(val)}
              />
              <Area type="monotone" dataKey="strategyValue" stroke="#10b981" strokeWidth={2} fillOpacity={1} fill="url(#colorStrat)" name="Rebalancing Strategy" />
              <Line type="monotone" dataKey="hodlValue" stroke="#64748b" strokeWidth={2} strokeDasharray="4 4" dot={false} name="Buy & Hold" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Asset Price + Trades */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-sm">
          <div className="mb-4">
            <h3 className="text-sm font-medium text-slate-300">Underlying Asset Price</h3>
            <p className="text-xs text-slate-500">Dots indicate rebalancing events (Green=Buy, Red=Sell)</p>
          </div>
          <div className="h-[250px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={simResult.data}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                <XAxis dataKey="day" stroke="#475569" tick={{fontSize: 12}} minTickGap={30} />
                <YAxis stroke="#475569" tick={{fontSize: 12}} domain={['auto', 'auto']} />
                <Tooltip contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', color: '#f1f5f9' }} labelFormatter={(l) => `Day ${l}`} />
                <Line type="monotone" dataKey="price" stroke="#818cf8" strokeWidth={1.5} dot={<RebalanceDot />} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Asset Allocation Chart */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-sm">
            <div className="mb-4 flex justify-between items-center">
            <h3 className="text-sm font-medium text-slate-300 flex items-center gap-2">
                <Sliders size={16} /> Portfolio Allocation %
            </h3>
            <div className="text-xs text-indigo-400 flex flex-col items-end">
              <span>Mode: {strategy.allocationMode === 'fixed' ? 'Fixed' : (strategy.allocationMode === 'rsi' ? 'RSI Dynamic' : 'ADX Dynamic')}</span>
              {strategy.allocationMode === 'fixed' && <span>Target: {(strategy.targetAllocation*100).toFixed(0)}%</span>}
            </div>
          </div>
          <div className="h-[250px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={simResult.data}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                <XAxis dataKey="day" stroke="#475569" tick={{fontSize: 12}} minTickGap={30} />
                <YAxis stroke="#475569" tick={{fontSize: 12}} domain={[0, 1]} tickFormatter={(v) => `${(v*100).toFixed(0)}%`} />
                <Tooltip contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', color: '#f1f5f9' }} formatter={(v: number) => (v*100).toFixed(2) + '%'} />
                
                {strategy.allocationMode !== 'fixed' && (
                  <Line type="step" dataKey="targetAllocation" stroke="#a78bfa" strokeWidth={2} dot={false} name="Dynamic Target" />
                )}
                {strategy.allocationMode === 'fixed' && strategy.rebalanceType === 'threshold' && (
                  <>
                    <Line type="linear" dataKey={() => strategy.targetAllocation + strategy.rebalanceThreshold} stroke="#ef4444" strokeDasharray="3 3" strokeWidth={1} dot={false} activeDot={false} name="Upper Limit" />
                    <Line type="linear" dataKey={() => strategy.targetAllocation - strategy.rebalanceThreshold} stroke="#10b981" strokeDasharray="3 3" strokeWidth={1} dot={false} activeDot={false} name="Lower Limit" />
                  </>
                )}
                <Line type="monotone" dataKey="allocation" stroke="#cbd5e1" strokeWidth={2} dot={false} name="Current Weight" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
};

// --- 7. Main Application Component ---

const App = () => {
  const [market, setMarket] = useState<MarketConfig>({
    initialPrice: 100,
    days: 365,
    type: 'GBM',
    drift: 0.05,
    volatility: 0.40,
    meanReversionSpeed: 5.0,
    longTermMean: 100,
    jumpIntensity: 2,
    jumpMean: -0.15,
    jumpStdDev: 0.1
  });

  const [strategy, setStrategy] = useState<StrategyConfig>({
    initialCapital: 10000,
    allocationMode: 'fixed',
    targetAllocation: 0.50,
    minAllocation: 0.20,
    maxAllocation: 0.80,
    indicatorPeriod: 14,
    adxThreshold: 25,
    rebalanceType: 'threshold',
    rebalanceThreshold: 0.05,
    rebalanceFrequency: 30,
    transactionFeeRate: 0.001,
  });

  const [pricePath, setPricePath] = useState<number[]>([]);
  const [simResult, setSimResult] = useState<SimulationResult | null>(null);

  const regenerateMarket = useCallback(() => {
    const path = generatePricePath(market);
    setPricePath(path);
  }, [market]);

  useEffect(() => {
    regenerateMarket();
  }, []);

  useEffect(() => {
    if (pricePath.length > 0) {
      const result = runSimulation(market, strategy, pricePath);
      setSimResult(result);
    }
  }, [pricePath, market, strategy]);

  const applyPreset = (type: 'BULL' | 'BEAR' | 'SIDEWAYS' | 'VOLATILE' | 'CRASH') => {
    switch(type) {
      case 'BULL':
        setMarket(prev => ({ ...prev, type: 'GBM', drift: 0.25, volatility: 0.20 }));
        break;
      case 'BEAR':
        setMarket(prev => ({ ...prev, type: 'GBM', drift: -0.20, volatility: 0.25 }));
        break;
      case 'SIDEWAYS':
        setMarket(prev => ({ ...prev, type: 'OU', meanReversionSpeed: 6.0, volatility: 0.30, longTermMean: prev.initialPrice }));
        break;
      case 'VOLATILE':
        setMarket(prev => ({ ...prev, type: 'GBM', drift: 0.0, volatility: 0.80 }));
        break;
      case 'CRASH':
        setMarket(prev => ({ ...prev, type: 'JUMP', drift: 0.05, volatility: 0.20, jumpIntensity: 3, jumpMean: -0.20, jumpStdDev: 0.05 }));
        break;
    }
  };

  return (
    <div className="flex h-screen bg-slate-950 text-slate-200 overflow-hidden font-sans">
      <aside className="w-80 flex-shrink-0 border-r border-slate-800 bg-slate-900/50 flex flex-col overflow-y-auto">
        <MarketControls 
          market={market} 
          setMarket={setMarket} 
          regenerateMarket={regenerateMarket} 
          applyPreset={applyPreset} 
        />
        <StrategyControls 
          strategy={strategy} 
          setStrategy={setStrategy} 
        />
      </aside>

      <main className="flex-1 flex flex-col h-full overflow-hidden relative">
        {simResult && <StatsPanel simResult={simResult} />}
        {simResult && <ChartsPanel simResult={simResult} strategy={strategy} />}
      </main>
    </div>
  );
};

export default App;
