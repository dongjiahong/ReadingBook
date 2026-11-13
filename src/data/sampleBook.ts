import type { AnnotationCardItem, BookAnchor, BookParagraph, CardEdge } from '../types';

export const SAMPLE_BOOK_PARAGRAPHS: BookParagraph[] = [
  {
    id: 'p-heading-1',
    type: 'heading',
    text: 'Act III, Scene 1',
  },
  {
    id: 'p-stage-1',
    type: 'stage',
    text: 'A room in the castle. Enter Hamlet.',
  },
  {
    id: 'p-quote-1',
    type: 'quote',
    lines: [
      { id: 'q-line-1', text: 'To be, or not to be, that is the question:' },
      { id: 'q-line-2', text: "Whether 'tis nobler in the mind to suffer" },
      { id: 'q-line-3', text: 'The slings and arrows of outrageous fortune,' },
      { id: 'q-line-4', text: 'Or to take arms against a sea of troubles' },
      { id: 'q-line-5', text: 'And by opposing end them.' },
    ],
  },
  {
    id: 'p-heading-2',
    type: 'heading',
    text: 'Notes',
  },
  {
    id: 'p-prose-1',
    type: 'prose',
    text: "Hamlet's question is not only whether to live or die. He is weighing whether it is nobler to endure what fortune sends or to fight it. In the end, the fear of what comes after death keeps him from acting.",
  },
  {
    id: 'p-table-1',
    type: 'table',
    rows: [
      { line: '3', image: 'Slings and arrows', reading: 'Fortune as an archer' },
      { line: '4', image: 'A sea of troubles', reading: 'A fight no one can win' },
      { line: '5', image: 'End them', reading: 'The troubles, or his life' },
    ],
  },
  {
    id: 'p-heading-3',
    type: 'heading',
    text: 'Extended Commentary (Scroll to test native unified scroll)',
  },
  {
    id: 'p-prose-2',
    type: 'prose',
    text: 'Notice how Shakespeare deliberately shifts from archery ("slings and arrows") to maritime warfare ("a sea of troubles"). In classical rhetoric, mixing metaphors signals a mind under extreme cognitive pressure—rationality fracturing under existential dread.',
  },
  {
    id: 'p-prose-3',
    type: 'prose',
    text: 'Try selecting any sentence in this section to create a new highlight or underline annotation. Then drag cards arbitrarily far to the right, paste screenshots directly into any card, or click + to branch out secondary thoughts.',
  },
];

export const INITIAL_ANCHORS: BookAnchor[] = [
  {
    id: 'anchor-1',
    paragraphId: 'q-line-4',
    quote: 'Or to take arms against a sea of troubles',
    startOffset: 0,
    endOffset: 42,
    style: 'highlight',
    badgeNumber: 1,
    kind: 'review',
    targetNodeId: 'card-1',
  },
  {
    id: 'anchor-2',
    paragraphId: 'p-prose-1',
    quote: "Hamlet's question is not only whether to live or die.",
    startOffset: 0,
    endOffset: 54,
    style: 'underline',
    badgeNumber: 1,
    kind: 'revision',
    targetNodeId: 'card-2',
  },
  {
    id: 'anchor-3',
    paragraphId: 'p-prose-1',
    quote: 'In the end, the fear of what comes after death keeps him from acting.',
    startOffset: 132,
    endOffset: 202,
    style: 'underline',
    badgeNumber: 2,
    kind: 'revision',
    targetNodeId: 'card-3',
  },
];

export const INITIAL_CARDS: AnnotationCardItem[] = [
  {
    id: 'card-1',
    x: 44,
    y: 185,
    kind: 'review',
    badgeNumber: 1,
    body: 'A mixed metaphor on purpose: no one can take arms against the sea. Worth a line in your note.',
    anchorId: 'anchor-1',
  },
  {
    id: 'card-1-branch',
    x: 348,
    y: 170,
    kind: 'thought',
    body: '右侧画布与左侧书页共享原生滚动，并可向右侧无限延展；卡片支持粘贴截图或拖入图片，高度自动扩张。',
  },
  {
    id: 'card-2',
    x: 44,
    y: 350,
    kind: 'revision',
    badgeNumber: 1,
    body: "Hamlet's question is not really only about whether to live or to die, if you think about it.",
    status: 'pending',
    anchorId: 'anchor-2',
  },
  {
    id: 'card-3',
    x: 44,
    y: 485,
    kind: 'revision',
    badgeNumber: 2,
    body: 'In the end, it seems to be the fear of what might come after death that is the thing that keeps him from acting.',
    status: 'pending',
    anchorId: 'anchor-3',
  },
];

export const INITIAL_CARD_EDGES: CardEdge[] = [
  {
    id: 'edge-card-1-branch',
    source: 'card-1',
    target: 'card-1-branch',
    color: '#c9a227',
  },
];
