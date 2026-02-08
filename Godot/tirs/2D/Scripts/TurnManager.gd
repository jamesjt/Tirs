# TurnManager.gd (attached to TurnManager node)
extends Node

var current_player: int = 0
var activated_units = []
var action_stack = []  # For undo: [unit, old_pos, new_pos]
var round: int = 1

func start_turn():
	activated_units.clear()
	get_tree().call_group("units", "set", "activated", false)

func activate_unit(unit):
	if unit.owner != current_player or unit.activated:
		return false
	unit.activated = true
	activated_units.append(unit)
	return true

func record_move(unit, old_pos: Vector2, new_pos: Vector2):
	action_stack.append([unit, old_pos, new_pos])

func undo_last():
	if action_stack.empty():
		return
	var action = action_stack.pop_back()
	var unit = action[0]
	unit.move_to(action[1].x, action[1].y)  # Revert to old position

func end_turn():
	action_stack.clear()
	current_player = 1 - current_player
	if current_player == 0:
		round += 1
		if round > 4:
			end_game()
	start_turn()

func end_game():
	# Calculate final scores (to be implemented)
	pass
	
	func calculate_points():
	var scores = [0, 0]
	var objectives = get_tree().get_nodes_in_group("objectives")
	for obj in objectives:
		if obj.controlled_by >= 0:
			var points = 1 if obj.objective == "shard" else 2 + round - 1
			scores[obj.controlled_by] += points
	# Add unit survival points at game end
	if round > 4:
		var units = get_tree().get_nodes_in_group("units")
		for unit in units:
			if unit.health > 0:
				scores[unit.owner] += unit.cost / 2  # Assume cost is a unit property
	return scores
