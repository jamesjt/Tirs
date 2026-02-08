# HexGrid.gd (attached to HexGrid node)
extends Node2D

var hex_size := 50.0  # Radius of hex in pixels
var grid = {}  # Dictionary to store hexes: Vector2(q, r) -> HexTile

func _ready():
	generate_map()

func generate_map():
	# Example: 5x5 hex grid centered at (0, 0)
	for q in range(-2, 3):
		for r in range(-2, 3):
			if abs(q + r) <= 4:  # Rough hexagonal shape
				var hex = preload("res://HexTile.tscn").instantiate()
				hex.position = axial_to_pixel(q, r)
				hex.q = q
				hex.r = r
				add_child(hex)
				grid[Vector2(q, r)] = hex
				# Set deployment zones and objectives
				if q < -1: hex.set_type("green")  # Player 1 deployment
				elif q > 1: hex.set_type("brown")  # Player 2 deployment
				elif q == 0 and r == 0: hex.set_objective("slab")
				elif abs(q) == 1 and abs(r) == 1: hex.set_objective("shard")

func axial_to_pixel(q: int, r: int) -> Vector2:
	var x = hex_size * 3/2 * q
	var y = hex_size * sqrt(3) * (r + q/2.0)
	return Vector2(x, y)
