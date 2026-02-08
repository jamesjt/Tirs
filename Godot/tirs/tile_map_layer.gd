# BattleMap.gd
extends TileMap
class_name BattleMap

const DIRECTIONS_ODD_R = [
	[Vector2(1,  0), Vector2(0, -1), Vector2(-1, -1), 
	 Vector2(-1,  0), Vector2(-1, 1), Vector2(0, 1)],
	[Vector2(1,  0), Vector2(1, -1), Vector2(0, -1), 
	 Vector2(-1,  0), Vector2(0, 1), Vector2(1, 1)]]
const DIRECTIONS_ODD_Q = [
	[Vector2(1,  0), Vector2(1, -1), Vector2(0, -1), 
	 Vector2(1,  -1), Vector2(-1, 0), Vector2(0, 1)],
	[Vector2(1,  1), Vector2(1, 0), Vector2(0, -1), 
	 Vector2(-1,  0), Vector2(-1, 1), Vector2(0, 1)]]
const DIRECTIONS_SQUARE = [
	Vector2(1,0), Vector2(1,-1), Vector2(0,-1), Vector2(-1,-1),
	Vector2(-1,0), Vector2(-1,1), Vector2(0,1), Vector2(1,1)]


func directions(point : Vector2) -> Array:
	""" note that i am adding an empty array to make sure 
		nothing can unintentionally change the array """
	if cell_half_offset == HALF_OFFSET_X:
		return [] + DIRECTIONS_ODD_R[int(point.y) & 1]
	elif cell_half_offset == HALF_OFFSET_Y:
		return [] + DIRECTIONS_ODD_Q[int(point.x) & 1]
	else:
		return [] + DIRECTIONS_SQUARE


func euclidean(a : Vector2, b : Vector2) -> float:	
	if cell_half_offset == HALF_OFFSET_X:
		a += Vector2(int(a.y) & 1, 0) * 0.5
		b += Vector2(int(b.y) & 1, 0) * 0.5
	elif cell_half_offset == HALF_OFFSET_Y:
		a += Vector2(0, int(a.x) & 1) * 0.5
		b += Vector2(0, int(b.x) & 1) * 0.5
	
	return (a-b).length()


func manhattan(a : Vector2, b : Vector2) -> float:
	if cell_half_offset == HALF_OFFSET_DISABLED:
		return abs(a.x - b.x) + abs(a.y - b.y)
	elif cell_half_offset == HALF_OFFSET_Y:
		return max(
			abs(a.y - b.y + floor(b.x/2) - floor(a.x/2)),
			max(abs(b.y - a.y + floor(a.x/2) - floor(b.x/2) + b.x - a.x),
			abs(a.x - b.x)))
	else:
		return max(
			abs(a.x - b.x + floor(b.y/2) - floor(a.y/2)),
			max(abs(b.x - a.x + floor(a.y/2) - floor(b.y/2) + b.y - a.y),
			abs(a.y - b.y)))
