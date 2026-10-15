import type { BoardColumn, Card } from "../shared/board-model";

function CardView({ card, onOpen }: { card: Card; onOpen: (id: string) => void }) {
  const { session, stageChip, badges } = card;
  return (
    <button type="button" className="card" data-testid={`card-${session.id}`} onClick={() => onOpen(session.id)}>
      <span className="card-title">
        <span className={`dot status-${session.status.toLowerCase()}`} title={session.status} aria-label={session.status} />
        <span className="truncate">{session.title}</span>
      </span>
      <span className="card-meta truncate">
        {card.repo}
        {card.branch && <span className="branch"> · {card.branch}</span>}
      </span>
      <span className="card-meta">
        {session.tool}
        {session.last_activity && <> · {new Date(session.last_activity).toLocaleString()}</>}
      </span>
      {(stageChip || badges.length > 0) && (
        <span className="chips">
          {stageChip && (
            <span className="chip stage" data-testid="stage-chip">
              {stageChip}
            </span>
          )}
          {badges.map((b, i) => (
            <span key={i} className={`chip tone-${b.tone}`} title={b.tooltip}>
              {[b.icon, b.text].filter(Boolean).join(" ")}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

export function Board({ columns, onOpen }: { columns: BoardColumn[]; onOpen: (id: string) => void }) {
  return (
    <main className="board">
      {columns.map(({ column, cards }) => (
        <section key={column.id} className="column" aria-label={column.title} data-testid={`column-${column.id}`}>
          <h2>
            {column.title} <span className="count">{cards.length}</span>
          </h2>
          <ul>
            {cards.map((card) => (
              <li key={card.session.id}>
                <CardView card={card} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
