# HexTile.gd (attached to HexTile node)
extends Node2D

var q: int
var r: int
var type: String = "neutral"  # green, brown, or neutral
var objective: String = ""    # shard, slab, or empty
var controlled_by: int = -1   # -1 = neutral, 0 = player 1, 1 = player 2

func set_type(new_type: String):
	type = new_type
	update_visuals()

func set_objective(obj: String):
	objective = obj
	update_visuals()

func update_visuals():
	# Placeholder: Use sprites or colors to differentiate
	$Sprite.modulate = Color.GREEN if type == "green" else Color.BROWN if type == "brown" else Color.WHITE
	if objective == "shard": $Sprite.modulate = Color.BLUE
	elif objective == "slab": $Sprite.modulate = Color.PURPLE
