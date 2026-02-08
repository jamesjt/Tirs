# Unit.gd (attached to Unit node)
extends Node2D

var health: int = 5
var armor: int = 1
var move: int = 3
var attack_type: String = "direct"
var attack_range: int = 1
var attack_damage: int = 2
var owner: int = 0  # 0 = player 1, 1 = player 2
var hex_pos: Vector2  # Axial coords (q, r)
var activated: bool = false

func move_to(new_q: int, new_r: int):
	hex_pos = Vector2(new_q, new_r)
	position = get_parent().get_parent().axial_to_pixel(new_q, new_r)
