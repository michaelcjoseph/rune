# [Project Name] Specification

## Overview

[What this project is, why it matters, and how it fits into Jarvis.]

### Core Value Proposition

[One sentence: the key benefit to Jarvis and the knowledge base.]

### Goals

1. **Primary:** [Main objective]
2. **Secondary:** [Supporting objective]
3. **Tertiary:** [Nice-to-have objective]

### Non-Goals

- [Explicitly out of scope item — be specific]
- [Another non-goal]

---

## User Journey

### Happy Path

```
[Step 1] → [Step 2] → [Step 3]
              ↓
         [Branch path]
```

1. **[Entry point]** — [what the user does and sees]
2. **[Key interaction]** — [what happens next]
3. **[Outcome]** — [where the user ends up]

### Entry Points

- [How users discover / access this feature]

### Exit Points

- [Where users go after completing the flow]

---

## Requirements

### [Feature Area 1]

1. WHEN [condition] THEN [expected behavior]
2. WHEN [condition] THEN [expected behavior]
3. WHEN [condition] THEN [expected behavior]

### [Feature Area 2]

4. WHEN [condition] THEN [expected behavior]
5. WHEN [condition] THEN [expected behavior]

---

## Technical Implementation

### Database Schema (Convex)

#### [New or updated table]:

```typescript
{
  // Field definitions with types
  fieldName: type, // Description
}
```

### API Endpoints (Convex Functions)

#### `namespace.functionName`

```typescript
// [Query | Mutation | Action]
Input: {
  field: type;
}
Output: {
  field: type;
}
```

### Frontend Components

#### Component Hierarchy

```
ParentComponent (data fetching, state)
├── ChildComponentA (view only)
├── ChildComponentB (view only)
└── ChildComponentC (view only)
```

#### `ComponentName.tsx`

```typescript
interface ComponentNameProps {
  prop: type; // Description
}
```

### Platform Considerations

- **Web:** [Next.js-specific notes]
- **Native:** [Expo/React Native-specific notes, or "N/A"]

---

## UI/UX Design

### Key Screens

#### [Screen Name]

- **Route:** `/path`
- **States:** [list of visual states]
- **Layout:** [description of layout and key elements]

### Visual Tokens

Reference `docs/design/design-brief.md` and `docs/design/style.md` for:

- Color palette and gradients
- Glass morphism card patterns
- Typography scale (Inter body, Instrument Serif display)
- 8px spacing grid
- Border radius scale (sm: 12px, md: 16px, lg: 20px)

---

## Implementation Phases

### Phase 1: [Name]

- [ ] [Deliverable]
- [ ] [Deliverable]
- [ ] [Deliverable]

### Phase 2: [Name]

> Depends on: Phase 1

- [ ] [Deliverable]
- [ ] [Deliverable]

### Phase 3: [Name]

> Depends on: Phase 2

- [ ] [Deliverable]
- [ ] [Deliverable]

---

## Success Metrics

### Core KPIs

| Metric | Target | How Measured |
| ------ | ------ | ------------ |
| [KPI]  | [goal] | [method]     |

### Analytics Events

```typescript
track('[event_name]', { key: value });
```

---

## Edge Cases & Error Handling

### [Category]

- [Boundary condition and how to handle it]
- [Invalid input scenario]
- [Integration failure mode and fallback]

---

## Open Questions

- [ ] [Unresolved decision to revisit]
- [ ] [Another open question]
