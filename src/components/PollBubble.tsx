import { useState } from 'react'
import type { Poll } from '../types'

type Props = {
  poll: Poll
  /** Sends the full set of options you now have picked ([] removes your vote). */
  onVote: (optionIds: number[]) => Promise<void>
}

/** What the poll looks like right after you pick `optionIds`, before WhatsApp confirms. */
function withMyVote(poll: Poll, optionIds: number[]): Poll {
  const hadVote = poll.options.some((option) => option.mine)
  const hasVote = optionIds.length > 0
  return {
    ...poll,
    voters: poll.voters + (hasVote && !hadVote ? 1 : 0) - (!hasVote && hadVote ? 1 : 0),
    options: poll.options.map((option) => {
      const mine = optionIds.includes(option.id)
      if (mine === option.mine) return option
      return {
        ...option,
        mine,
        votes: option.votes + (mine ? 1 : -1),
        voters: mine ? [...option.voters, 'Você'] : option.voters.filter((name) => name !== 'Você'),
      }
    }),
  }
}

export function PollBubble({ poll, onVote }: Props) {
  // Optimistic copy while a vote is on its way; cleared once the real poll comes back.
  const [pending, setPending] = useState<Poll | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showVotes, setShowVotes] = useState(false)
  const shown = pending ?? poll
  const top = Math.max(1, ...shown.options.map((option) => option.votes))

  async function pick(optionId: number) {
    if (busy) return
    const current = shown.options.filter((option) => option.mine).map((option) => option.id)
    const next = shown.multi
      ? current.includes(optionId)
        ? current.filter((id) => id !== optionId)
        : [...current, optionId]
      : current.includes(optionId)
        ? [] // tapping your own choice again removes the vote, like WhatsApp
        : [optionId]
    setPending(withMyVote(shown, next))
    setBusy(true)
    setError('')
    try {
      await onVote(next)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Não deu para votar')
    } finally {
      setPending(null)
      setBusy(false)
    }
  }

  return (
    <div className={`poll ${busy ? 'is-busy' : ''}`}>
      <strong className="poll-title">{shown.name || 'Enquete'}</strong>
      <span className="poll-hint">
        <span className="poll-hint-icon" aria-hidden="true">
          {shown.multi ? '☑' : '◉'}
        </span>
        {shown.multi ? 'Selecione uma ou mais opções' : 'Selecione uma opção'}
      </span>
      <div className="poll-options" role={shown.multi ? 'group' : 'radiogroup'} aria-label={shown.name}>
        {shown.options.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`poll-option ${option.mine ? 'is-mine' : ''}`}
            role={shown.multi ? 'checkbox' : 'radio'}
            aria-checked={option.mine}
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation()
              void pick(option.id)
            }}
          >
            <span className={`poll-mark ${shown.multi ? 'is-square' : 'is-round'}`} aria-hidden="true">
              {option.mine ? '✓' : ''}
            </span>
            <span className="poll-body">
              <span className="poll-line">
                <span className="poll-name">{option.name}</span>
                <span className="poll-count">{option.votes}</span>
              </span>
              <span className="poll-bar">
                <span style={{ width: `${(option.votes / top) * 100}%` }} />
              </span>
            </span>
          </button>
        ))}
      </div>
      {error ? <em className="poll-error">{error}</em> : null}
      <button
        type="button"
        className="poll-votes-toggle"
        disabled={!shown.voters}
        onClick={(event) => {
          event.stopPropagation()
          setShowVotes((open) => !open)
        }}
      >
        {!shown.voters ? 'Nenhum voto ainda' : showVotes ? 'Ocultar votos' : 'Ver votos'}
      </button>
      {showVotes && shown.voters ? (
        <div className="poll-details">
          {shown.options.map((option) => (
            <div key={option.id} className="poll-detail">
              <div className="poll-detail-head">
                <span>{option.name}</span>
                <span>
                  {option.votes} {option.votes === 1 ? 'voto' : 'votos'}
                </span>
              </div>
              {option.voters.length ? (
                <ul>
                  {option.voters.map((name, index) => (
                    <li key={`${name}-${index}`}>{name}</li>
                  ))}
                </ul>
              ) : (
                <span className="poll-detail-empty">Ninguém</span>
              )}
            </div>
          ))}
          <span className="poll-detail-total">
            {shown.voters} {shown.voters === 1 ? 'pessoa votou' : 'pessoas votaram'}
          </span>
        </div>
      ) : null}
    </div>
  )
}
