const { Pool, types } = require('pg');

// DATE como texto 'YYYY-MM-DD' e NUMERIC como número
types.setTypeParser(1082, (v) => v);
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.DB_POOL_MAX || 5), idleTimeoutMillis: 30000 });

const q = (text, params) => pool.query(text, params);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS config (
  chave TEXT PRIMARY KEY,
  valor JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS clientes (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  telefone TEXT NOT NULL,
  valor NUMERIC(12,2) NOT NULL,
  forma TEXT NOT NULL DEFAULT 'mensal',
  dia_vencimento INT NOT NULL,
  primeiro_vencimento DATE NOT NULL,
  parcelas_total INT,
  identificacao TEXT,
  endereco TEXT,
  observacoes TEXT,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  pausado BOOLEAN NOT NULL DEFAULT FALSE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cobrancas (
  id SERIAL PRIMARY KEY,
  cliente_id INT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  competencia DATE NOT NULL,
  numero_parcela INT,
  vencimento DATE NOT NULL,
  valor NUMERIC(12,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'aberto',
  pago_em DATE,
  pago_valor NUMERIC(12,2),
  forma_pagamento TEXT,
  obs TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cliente_id, competencia)
);
ALTER TABLE cobrancas ADD COLUMN IF NOT EXISTS pago_por TEXT;
CREATE INDEX IF NOT EXISTS cobrancas_venc_idx ON cobrancas (vencimento, status);

CREATE TABLE IF NOT EXISTS mensagens (
  id SERIAL PRIMARY KEY,
  cliente_id INT REFERENCES clientes(id) ON DELETE CASCADE,
  cobranca_id INT REFERENCES cobrancas(id) ON DELETE CASCADE,
  direcao TEXT NOT NULL,
  etapa TEXT,
  telefone TEXT,
  texto TEXT,
  status TEXT NOT NULL,
  erro TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mensagens_cob_idx ON mensagens (cobranca_id, etapa);
CREATE INDEX IF NOT EXISTS mensagens_data_idx ON mensagens (criado_em DESC);

CREATE TABLE IF NOT EXISTS comprovantes (
  id SERIAL PRIMARY KEY,
  cliente_id INT REFERENCES clientes(id) ON DELETE CASCADE,
  cobranca_id INT REFERENCES cobrancas(id) ON DELETE SET NULL,
  telefone TEXT,
  nome_contato TEXT,
  mimetype TEXT,
  nome_arquivo TEXT,
  legenda TEXT,
  arquivo BYTEA,
  status TEXT NOT NULL DEFAULT 'pendente',
  recebido_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolvido_em TIMESTAMPTZ
);
`;

async function migrar() {
  for (let tentativa = 1; tentativa <= 30; tentativa++) {
    try {
      await q(SCHEMA);
      return;
    } catch (e) {
      if (tentativa === 30) throw e;
      console.log(`Aguardando banco de dados (${tentativa})...`, e.code || e.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

module.exports = { pool, q, migrar };
