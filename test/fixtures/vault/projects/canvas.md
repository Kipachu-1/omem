---
title: Canvas Renderer
tags: [project/canvas]
---
The canvas renderer draws the whiteboard scene.

## Architecture

Layered rendering pipeline with a dirty-rect scheduler. Owner: [[Bob Smith|Bobby]].
Profiling notes live in [[GPU Profiling#Tools]]. See also [[Future Note]].

## Performance

Canvas rendering performance degrades when many layers are visible. Batching
draw calls fixed the frame drops on large boards.
