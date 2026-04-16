'use client';

import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, Type, Schema } from '@google/genai';
import { Upload, FileText, CheckCircle, Clock, AlertCircle, Download, ChevronRight, FileSpreadsheet, Trash2 } from 'lucide-react';
import * as XLSX from 'xlsx';
import { motion, AnimatePresence } from 'motion/react';

// Initialize Gemini API (Default/Free Quota)
const defaultAi = new GoogleGenAI({ apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY });

// Initialize Personal Gemini API (Fallback)
const personalAi = process.env.NEXT_PUBLIC_PERSONAL_GEMINI_API_KEY 
  ? new GoogleGenAI({ apiKey: process.env.NEXT_PUBLIC_PERSONAL_GEMINI_API_KEY }) 
  : null;

// Wrapper to handle quota fallback
async function generateContentWithFallback(params: any) {
  try {
    return await defaultAi.models.generateContent(params);
  } catch (error: any) {
    const isQuotaError = error.status === 429 || 
                         (error.message && error.message.includes('429')) || 
                         (error.message && error.message.toLowerCase().includes('quota'));
                         
    if (isQuotaError && personalAi) {
      console.warn("Cota gratuita excedida (429). Tentando novamente com a chave de API pessoal...");
      return await personalAi.models.generateContent(params);
    }
    throw error;
  }
}

type AppState = 'upload' | 'analyzing' | 'preview' | 'extracting' | 'result';

interface ColumnDef {
  id: string;
  nome: string;
  selected: boolean;
}

interface ExtractedRow {
  day: string;
  times: string[];
}

interface ExtractedMonth {
  month: string;
  rows: ExtractedRow[];
}

interface ExportHistory {
  id: string;
  date: string;
  fileName: string;
  months: ExtractedMonth[];
}

export default function PontoExtractor() {
  const [appState, setAppState] = useState<AppState>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [modelFile, setModelFile] = useState<File | null>(null);
  const [columns, setColumns] = useState<ColumnDef[]>([]);
  const [period, setPeriod] = useState<string>('');
  const [extractedData, setExtractedData] = useState<ExtractedMonth[]>([]);
  const [history, setHistory] = useState<ExportHistory[]>([]);
  const [error, setError] = useState<string | null>(null);
  
  // Timer state
  const [elapsedTime, setElapsedTime] = useState(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    // Load history from local storage
    const saved = localStorage.getItem('ponto_history');
    if (saved) {
      try {
        setHistory(JSON.parse(saved));
      } catch (e) {
        console.error('Failed to parse history', e);
      }
    }
  }, []);

  const saveHistory = (newHistory: ExportHistory[]) => {
    setHistory(newHistory);
    localStorage.setItem('ponto_history', JSON.stringify(newHistory));
  };

  const startTimer = () => {
    setElapsedTime(0);
    timerRef.current = setInterval(() => {
      setElapsedTime((prev) => prev + 1);
    }, 1000);
  };

  const stopTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          // Remove the data URL prefix (e.g., "data:application/pdf;base64,")
          const base64 = reader.result.split(',')[1];
          resolve(base64);
        } else {
          reject(new Error('Failed to convert file to base64'));
        }
      };
      reader.onerror = error => reject(error);
    });
  };

  const handlePreAnalysis = async () => {
    if (!file) return;
    
    setAppState('analyzing');
    setError(null);
    startTimer();

    try {
      const base64Data = await fileToBase64(file);
      const mimeType = file.type;

      const response = await generateContentWithFallback({
        model: 'gemini-3-flash-preview',
        contents: [
          {
            inlineData: {
              data: base64Data,
              mimeType: mimeType,
            }
          },
          "Analise este cartão de ponto (que pode conter várias páginas). Identifique o período referente (mês/ano) e as colunas que contêm horários registrados (entradas e saídas). Liste o nome de cada coluna de horário encontrada. Considere o documento como um todo."
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              periodo: {
                type: Type.STRING,
                description: "O período referente ao cartão de ponto (ex: Janeiro/2023, 01/2023 a 31/01/2023)"
              },
              colunas: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING, description: "Um identificador único para a coluna (ex: col1)" },
                    nome: { type: Type.STRING, description: "O nome da coluna conforme aparece no documento (ex: Entrada 1, Saída 1, Ent1, Sai1)" }
                  },
                  required: ["id", "nome"]
                },
                description: "Lista de colunas de horários encontradas"
              }
            },
            required: ["periodo", "colunas"]
          }
        }
      });

      stopTimer();
      
      if (response.text) {
        const result = JSON.parse(response.text);
        setPeriod(result.periodo || 'Desconhecido');
        setColumns(result.colunas.map((c: any) => ({ ...c, selected: true })));
        setAppState('preview');
      } else {
        throw new Error('Resposta vazia da API');
      }

    } catch (err: any) {
      stopTimer();
      console.error(err);
      let errorMessage = err.message || 'Ocorreu um erro durante a análise.';
      if (errorMessage.includes('Rpc failed due to xhr error') || errorMessage.includes('413')) {
        errorMessage = 'O arquivo é muito grande ou a conexão expirou. Tente usar um arquivo menor ou dividi-lo em partes.';
      }
      setError(errorMessage);
      setAppState('upload');
    }
  };

  const handleExtraction = async () => {
    if (!file) return;
    
    setAppState('extracting');
    setError(null);
    startTimer();

    try {
      const base64Data = await fileToBase64(file);
      const mimeType = file.type;
      const selectedCols = columns.filter(c => c.selected).map(c => c.nome).join(', ');

      const prompt = `Extraia os dados deste cartão de ponto APENAS para as seguintes colunas de horários: ${selectedCols}.
O documento pode conter várias páginas (ex: uma página para cada mês). Você deve analisar TODAS as páginas do documento.
Para cada dia do mês, extraia:
- O dia (número).
- Os horários registrados nas colunas selecionadas. Formate os horários substituindo ':' por ',' (ex: 08:00 -> 08,00).
- Se o dia não tiver horários, mas tiver um texto (ex: 'domingo', 'feriado', 'férias'), ignore o texto e deixe a lista de horários vazia.
Retorne os dados de todos os meses encontrados, agrupados por mês.`;

      const response = await generateContentWithFallback({
        model: 'gemini-3-flash-preview',
        contents: [
          {
            inlineData: {
              data: base64Data,
              mimeType: mimeType,
            }
          },
          prompt
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            description: "Lista de meses extraídos",
            items: {
              type: Type.OBJECT,
              properties: {
                month: { type: Type.STRING, description: "Nome do mês e ano (ex: Janeiro 2023)" },
                rows: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      day: { type: Type.STRING, description: "Dia do mês (ex: 01, 02, 15)" },
                      times: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                        description: "Lista de horários extraídos para as colunas selecionadas, no formato HH,MM. Vazio se não houver horários."
                      }
                    },
                    required: ["day", "times"]
                  }
                }
              },
              required: ["month", "rows"]
            }
          }
        }
      });

      stopTimer();
      
      if (response.text) {
        const result = JSON.parse(response.text) as ExtractedMonth[];
        setExtractedData(result);
        
        // Save to history
        const newRecord: ExportHistory = {
          id: Date.now().toString(),
          date: new Date().toISOString(),
          fileName: file.name,
          months: result
        };
        saveHistory([newRecord, ...history]);
        
        setAppState('result');
      } else {
        throw new Error('Resposta vazia da API');
      }

    } catch (err: any) {
      stopTimer();
      console.error(err);
      let errorMessage = err.message || 'Ocorreu um erro durante a extração.';
      if (errorMessage.includes('Rpc failed due to xhr error') || errorMessage.includes('413')) {
        errorMessage = 'O arquivo é muito grande ou a conexão expirou. Tente usar um arquivo menor ou dividi-lo em partes.';
      }
      setError(errorMessage);
      setAppState('preview');
    }
  };

  const exportToExcel = async (dataToExport: ExtractedMonth[], filename: string) => {
    let wb = XLSX.utils.book_new();
    let wsData: any[][] = [];

    if (modelFile) {
      try {
        const data = await modelFile.arrayBuffer();
        wb = XLSX.read(data, { type: 'array' });
        const firstSheetName = wb.SheetNames[0];
        const ws = wb.Sheets[firstSheetName];
        wsData = XLSX.utils.sheet_to_json(ws, { header: 1 });
        
        // Add a couple of blank lines before appending
        wsData.push([]);
        wsData.push([]);
      } catch (e) {
        console.error('Error reading model file', e);
        // Fallback to empty
      }
    }

    // Header
    wsData.push(['Dia', ...columns.filter(c => c.selected).map(c => c.nome)]);

    dataToExport.forEach((monthData, mIndex) => {
      // Month header
      wsData.push([monthData.month]);
      
      monthData.rows.forEach(row => {
        wsData.push([row.day, ...row.times]);
      });

      // Add blank lines between months
      if (mIndex < dataToExport.length - 1) {
        wsData.push([]);
        wsData.push([]);
        wsData.push([]);
      }
    });

    const ws = XLSX.utils.aoa_to_sheet(wsData);
    
    if (modelFile && wb.SheetNames.length > 0) {
      wb.Sheets[wb.SheetNames[0]] = ws;
    } else {
      XLSX.utils.book_append_sheet(wb, ws, 'Cartão de Ponto');
    }
    
    XLSX.writeFile(wb, `${filename.replace(/\.[^/.]+$/, "")}_extraido.xlsx`);
  };

  const toggleColumn = (id: string) => {
    setColumns(columns.map(c => c.id === id ? { ...c, selected: !c.selected } : c));
  };

  const reset = () => {
    setAppState('upload');
    setFile(null);
    setModelFile(null);
    setColumns([]);
    setPeriod('');
    setExtractedData([]);
    setError(null);
    stopTimer();
  };

  const deleteHistoryItem = (id: string) => {
    const newHistory = history.filter(item => item.id !== id);
    saveHistory(newHistory);
  };

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-[#F0F2F5] text-[#1E293B] font-sans">
      {/* Header */}
      <header className="h-16 bg-white border-b border-[#E2E8F0] flex items-center justify-between px-6 shrink-0">
        <div className="font-extrabold text-xl text-[#2563EB] tracking-tight">
          TIMECARD<span className="text-[#64748B]">PRO</span>
        </div>
        <div className="flex gap-3">
          {/* Header actions if needed */}
        </div>
      </header>

      <div className="grid grid-cols-[260px_1fr] flex-grow h-[calc(100vh-64px)]">
        {/* Sidebar History */}
        <aside className="bg-white border-r border-[#E2E8F0] p-6 flex flex-col gap-5 overflow-y-auto">
          <div>
            <div className="text-xs uppercase tracking-wider text-[#64748B] font-bold mb-3">Histórico de Exportação</div>
            <div className="flex flex-col gap-2">
              {history.length === 0 ? (
                <p className="text-sm text-[#64748B] text-center mt-4">Nenhum histórico encontrado.</p>
              ) : (
                history.map(item => (
                  <div key={item.id} className="p-3 rounded-lg border border-[#E2E8F0] bg-[#F0F2F5] hover:border-[#2563EB] transition-colors cursor-pointer group">
                    <div className="flex justify-between items-start">
                      <div className="truncate pr-2">
                        <h4 className="text-sm font-semibold text-[#1E293B] mb-1 truncate" title={item.fileName}>{item.fileName}</h4>
                        <span className="text-xs text-[#64748B]">{new Date(item.date).toLocaleDateString('pt-BR')} • {item.months.length} meses</span>
                      </div>
                      <div className="flex flex-col gap-1">
                        <button 
                          onClick={() => exportToExcel(item.months, item.fileName)}
                          className="text-[#64748B] hover:text-[#2563EB] p-1"
                          title="Exportar novamente"
                        >
                          <Download size={16} />
                        </button>
                        <button 
                          onClick={() => deleteHistoryItem(item.id)}
                          className="text-[#64748B] hover:text-red-600 p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Excluir histórico"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </aside>

        {/* Main Content */}
        <main className="p-6 flex flex-col gap-6 overflow-y-auto">
          
          {/* Step Indicator */}
          <div className="flex gap-3 items-center mb-2">
            <div className={`flex items-center gap-2 text-sm font-semibold ${appState === 'upload' ? 'text-[#2563EB]' : 'text-[#64748B]'}`}>1. Upload</div>
            <div className="text-[#E2E8F0]">→</div>
            <div className={`flex items-center gap-2 text-sm font-semibold ${appState === 'analyzing' || appState === 'preview' ? 'text-[#2563EB]' : 'text-[#64748B]'}`}>2. Pré-Análise & Seleção</div>
            <div className="text-[#E2E8F0]">→</div>
            <div className={`flex items-center gap-2 text-sm font-semibold ${appState === 'extracting' || appState === 'result' ? 'text-[#2563EB]' : 'text-[#64748B]'}`}>3. Exportação Final</div>
          </div>

          <div className="bg-white rounded-xl border border-[#E2E8F0] flex-grow flex flex-col overflow-hidden shadow-[0_4px_6px_-1px_rgba(0,0,0,0.1)] relative">
            
            {/* Workspace Header */}
            <div className="px-6 py-4 border-b border-[#E2E8F0] flex justify-between items-center bg-[#EFF6FF]">
              <div>
                <h3 className="text-base font-semibold text-[#1E293B]">
                  Documento: <span className="font-normal">{file ? file.name : 'Nenhum arquivo selecionado'}</span>
                </h3>
                {period && <p className="text-xs text-[#64748B] mt-1">Período Identificado: <b className="text-[#1E293B]">{period}</b></p>}
              </div>
              <div className="flex gap-2">
                {appState === 'preview' && (
                  <button
                    onClick={handleExtraction}
                    disabled={!columns.some(c => c.selected)}
                    className="px-5 py-2.5 rounded-md bg-[#2563EB] text-white font-semibold text-sm hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors"
                  >
                    Iniciar Extração
                  </button>
                )}
                {appState === 'result' && (
                  <button 
                    onClick={() => exportToExcel(extractedData, file?.name || 'export')}
                    className="px-5 py-2.5 rounded-md bg-[#10B981] text-white font-semibold text-sm hover:bg-emerald-600 transition-colors flex items-center gap-2"
                  >
                    <Download size={16} />
                    Exportar Excel
                  </button>
                )}
                {(appState === 'preview' || appState === 'result') && (
                  <button 
                    onClick={reset}
                    className="px-5 py-2.5 rounded-md bg-white border border-[#E2E8F0] text-[#1E293B] font-semibold text-sm hover:bg-slate-50 transition-colors"
                  >
                    Novo Upload
                  </button>
                )}
              </div>
            </div>

            {/* Workspace Content */}
            <div className="flex-grow p-6 overflow-y-auto">
              {error && (
                <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3 text-red-700">
                  <AlertCircle className="shrink-0 mt-0.5" size={20} />
                  <div>
                    <h3 className="font-semibold text-sm">Erro</h3>
                    <p className="text-sm">{error}</p>
                  </div>
                </div>
              )}

              <AnimatePresence mode="wait">
                {appState === 'upload' && (
                  <motion.div 
                    key="upload"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -20 }}
                    className="space-y-8"
                  >
                    <div className="grid md:grid-cols-2 gap-6">
                      {/* Model File Upload */}
                      <div className="bg-white p-6 rounded-xl border border-[#E2E8F0]">
                        <h3 className="text-sm font-semibold text-[#1E293B] mb-2 flex items-center gap-2">
                          <FileSpreadsheet size={18} className="text-[#10B981]" />
                          Arquivo Modelo (Opcional)
                        </h3>
                        <p className="text-xs text-[#64748B] mb-4">Envie uma planilha modelo para manter o formato.</p>
                        
                        <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-[#E2E8F0] border-dashed rounded-lg cursor-pointer bg-[#F0F2F5] hover:bg-[#E2E8F0] transition-colors">
                          <div className="flex flex-col items-center justify-center pt-5 pb-6">
                            <Upload className="w-6 h-6 mb-2 text-[#64748B]" />
                            <p className="text-sm text-[#64748B]">
                              {modelFile ? <span className="font-semibold text-[#10B981]">{modelFile.name}</span> : "Clique ou arraste (.xlsx)"}
                            </p>
                          </div>
                          <input type="file" className="hidden" accept=".xlsx, .xls" onChange={(e) => setModelFile(e.target.files?.[0] || null)} />
                        </label>
                      </div>

                      {/* Time Card Upload */}
                      <div className="bg-white p-6 rounded-xl border border-[#E2E8F0]">
                        <h3 className="text-sm font-semibold text-[#1E293B] mb-2 flex items-center gap-2">
                          <FileText size={18} className="text-[#2563EB]" />
                          Cartão de Ponto
                        </h3>
                        <p className="text-xs text-[#64748B] mb-4">Envie o documento com os registros de horários.</p>
                        
                        <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-[#2563EB] border-dashed rounded-lg cursor-pointer bg-[#EFF6FF] hover:bg-blue-100 transition-colors">
                          <div className="flex flex-col items-center justify-center pt-5 pb-6">
                            <Upload className="w-6 h-6 mb-2 text-[#2563EB]" />
                            <p className="text-sm text-[#64748B]">
                              {file ? <span className="font-semibold text-[#2563EB]">{file.name}</span> : "Clique ou arraste (PDF, JPG, PNG)"}
                            </p>
                          </div>
                          <input type="file" className="hidden" accept="application/pdf, image/*" onChange={(e) => setFile(e.target.files?.[0] || null)} />
                        </label>
                      </div>
                    </div>

                    <div className="flex justify-center mt-8">
                      <button
                        onClick={handlePreAnalysis}
                        disabled={!file}
                        className="px-6 py-2.5 rounded-md bg-[#2563EB] text-white font-semibold text-sm hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
                      >
                        Analisar Documento
                        <ChevronRight size={18} />
                      </button>
                    </div>
                  </motion.div>
                )}

                {appState === 'preview' && (
                  <motion.div
                    key="preview"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                  >
                    <h3 className="text-sm font-semibold text-[#1E293B] mb-4 uppercase tracking-wider">Selecione as Colunas para Extração</h3>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                      {columns.map(col => (
                        <button
                          key={col.id}
                          onClick={() => toggleColumn(col.id)}
                          className={`p-4 rounded-lg border text-left transition-all flex items-center gap-3 ${
                            col.selected 
                              ? 'border-[#2563EB] bg-[#EFF6FF]' 
                              : 'border-[#E2E8F0] bg-white hover:border-slate-300'
                          }`}
                        >
                          <div className={`w-[18px] h-[18px] rounded-[4px] border-2 flex items-center justify-center relative ${
                            col.selected ? 'border-[#2563EB] bg-[#2563EB]' : 'border-[#E2E8F0] bg-white'
                          }`}>
                            {col.selected && <span className="text-white text-[10px] absolute font-bold">✓</span>}
                          </div>
                          <div>
                            <div className={`font-semibold text-sm ${col.selected ? 'text-[#2563EB]' : 'text-[#1E293B]'}`}>{col.nome}</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </motion.div>
                )}

                {appState === 'result' && (
                  <motion.div
                    key="result"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="p-6"
                  >
                    <div className="flex flex-col items-center justify-center text-center space-y-4 py-12">
                      <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mb-4">
                        <CheckCircle size={32} className="text-emerald-600" />
                      </div>
                      <h2 className="text-2xl font-bold text-[#1E293B]">Extração Concluída com Sucesso!</h2>
                      <p className="text-[#64748B] max-w-md">
                        Os dados do documento <span className="font-semibold text-[#1E293B]">{file?.name}</span> referentes ao período <span className="font-semibold text-[#1E293B]">{period}</span> foram extraídos e estão prontos para download.
                      </p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Footer Status (Loading) */}
            {(appState === 'analyzing' || appState === 'extracting') && (
              <div className="h-[100px] bg-white border-t border-[#E2E8F0] p-5 px-6 flex items-center gap-10 absolute bottom-0 left-0 right-0">
                <div className="flex flex-col items-center font-mono text-xl font-bold text-[#2563EB]">
                  {formatTime(elapsedTime)}
                  <small className="text-[10px] uppercase text-[#64748B] tracking-widest font-sans mt-1">Processando</small>
                </div>
                <div className="flex-grow">
                  <div className="flex justify-between mb-2">
                    <span className="text-sm font-semibold text-[#1E293B]">
                      {appState === 'analyzing' ? 'Analisando estrutura do documento...' : 'Extraindo dados das colunas selecionadas...'}
                    </span>
                  </div>
                  <div className="h-2 bg-[#F0F2F5] rounded-full overflow-hidden relative">
                    <motion.div 
                      className="h-full bg-[#2563EB]"
                      initial={{ width: "0%" }}
                      animate={{ width: "100%" }}
                      transition={{ duration: 10, ease: "linear", repeat: Infinity }}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
